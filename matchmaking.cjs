// Load environment variables from .env file
require('dotenv').config()

const { Server } = require('socket.io')
const http = require('http')
const { Connection, PublicKey, Transaction, TransactionInstruction, Keypair, SystemProgram } = require('@solana/web3.js');
const { sha256 } = require('@noble/hashes/sha256');
const borsh = require('borsh');
const fs = require('fs');
const path = require('path');
const bs58 = require('bs58');

const server = http.createServer()

// Read allowed origins from environment variable (comma-separated)
const allowedOrigins = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : ['http://localhost:3000']

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST'],
    credentials: true
  }
})

const queue = []
const pairs = new Map()
const battleDeadlines = new Map() // Track battle deadlines for auto-resolution

// Track processed battles to prevent duplicate resolution
const processedBattles = new Set();

// Load server authority keypair from config string (copy from nuxt.config.ts or use process.env)
const serverAuthKeypairArray = JSON.parse(process.env.SERVER_AUTH_KEYPAIR || '');
const serverAuthority = Keypair.fromSecretKey(Uint8Array.from(serverAuthKeypairArray));

// At the top of the file, add:
const socketWallets = new Map();

// Dynamic IDL loading based on environment
const isProduction = process.env.NODE_ENV === 'production'
const idlPath = isProduction
  ? path.join(__dirname, 'gorbagana_program_idl.json')
  : path.join(__dirname, 'solana_program_idl.json')

let idl
try {
  idl = JSON.parse(fs.readFileSync(idlPath, 'utf8'))
  console.log(`[SERVER] Loaded IDL from ${idlPath}`)
} catch (err) {
  console.error(`[SERVER] Failed to load IDL from ${idlPath}:`, err)
  process.exit(1)
}

// Helper: Calculate Anchor discriminator
function getInstructionDiscriminator(name) {
  const preimage = `global:${name}`;
  const hash = sha256(Buffer.from(preimage, 'utf-8'));
  return Buffer.from(hash).subarray(0, 8);
}

// --- FIXED BORSH SCHEMA FOR ANCHOR ACCOUNT ---
// The key issues with the original schema:
// 1. Borsh v2.0.0 uses a different schema format
// 2. PublicKey fields need to be treated as fixed-size arrays of u8
// 3. Anchor accounts have an 8-byte discriminator prefix

class Battle {
  constructor(fields = {}) {
    this.stake = fields.stake || 0;
    this.players = fields.players || [new Array(32).fill(0), new Array(32).fill(0)];
    this.winner = fields.winner || new Array(32).fill(0);
    this.deadline = fields.deadline || 0;
  }
}

// Fixed Borsh v2.0.0 compatible schema (matches on-chain struct)
const BattleSchema = new Map([
  [Battle, {
    kind: 'struct',
    fields: [
      ['stake', 'u64'],
      ['players', [['u8', 32], 2]], // Array of 2 PublicKeys (each 32 bytes)
      ['winner', ['u8', 32]],       // Single PublicKey (32 bytes)
      ['deadline', 'i64']
    ]
  }]
]);

// Manual buffer parsing (matches on-chain struct)
function decodeBattleAccountManual(data) {
  try {
    // Skip 8-byte Anchor discriminator
    const accountData = data.slice(8);
    if (accountData.length < 8 + 64 + 32 + 8) {
      throw new Error('Account data too short');
    }
    let offset = 0;
    // Read stake (u64 - 8 bytes, little endian)
    const stakeBuffer = accountData.slice(offset, offset + 8);
    const stake = Number(Buffer.from(stakeBuffer).readBigUInt64LE());
    offset += 8;
    // Read players array (2 PublicKeys, 32 bytes each)
    const players = [];
    for (let i = 0; i < 2; i++) {
      const pubkeyBytes = accountData.slice(offset, offset + 32);
      const pubkey = new PublicKey(pubkeyBytes);
      players.push(pubkey.toBase58());
      offset += 32;
    }
    // Read winner (1 PublicKey, 32 bytes)
    const winnerBytes = accountData.slice(offset, offset + 32);
    const winner = new PublicKey(winnerBytes);
    offset += 32;
    // Read deadline (i64 - 8 bytes, little endian)
    const deadlineBuffer = accountData.slice(offset, offset + 8);
    const deadline = Number(Buffer.from(deadlineBuffer).readBigInt64LE());
    offset += 8;
    return {
      stake,
      players,
      winner: winner.toBase58(),
      deadline
    };
  } catch (err) {
    console.error('[SERVER] Manual decode error:', err);
    throw new Error(`Failed to decode battle account: ${err.message}`);
  }
}

// Borsh-based decoding function (fixed schema)
function decodeBattleAccountBorsh(data) {
  try {
    // Skip 8-byte Anchor discriminator
    const accountData = data.slice(8);
    const decoded = borsh.deserialize(BattleSchema, Battle, accountData);
    // Convert raw byte arrays to PublicKey strings
    const players = decoded.players.map(playerBytes => {
      return new PublicKey(Buffer.from(playerBytes)).toBase58();
    });
    const winner = new PublicKey(Buffer.from(decoded.winner)).toBase58();
    return {
      stake: Number(decoded.stake),
      players: players,
      winner: winner,
      deadline: Number(decoded.deadline)
    };
  } catch (err) {
    console.error('[SERVER] Borsh decode error:', err);
    // Fallback to manual parsing
    return decodeBattleAccountManual(data);
  }
}

// Use the manual parsing as primary method (more reliable)
function decodeBattleAccount(data) {
  return decodeBattleAccountManual(data);
}

// Dynamic environment selection
const PROGRAM_ID = isProduction
  ? process.env.PRODUCTION_PROGRAM_ID
  : process.env.DEVELOPMENT_PROGRAM_ID;

const RPC_URL = isProduction
  ? process.env.GORBAGANA_RPC_URL
  : process.env.SOLANA_DEVNET_RPC_URL;

console.log('[SERVER] NODE_ENV:', process.env.NODE_ENV);
console.log('[SERVER] Using PROGRAM_ID:', PROGRAM_ID);
console.log('[SERVER] Using RPC_URL:', RPC_URL);

// Server-side join_battle contract call
async function joinBattleOnChain({ battle, playerTwoBattle, playerOne, playerTwo, programId, rpcUrl }) {
  const connection = new Connection(rpcUrl, 'confirmed');
  const discriminator = getInstructionDiscriminator('join_battle');
  const data = discriminator; // No args for join_battle

  const keys = [
    { pubkey: new PublicKey(battle), isSigner: false, isWritable: true },
    { pubkey: new PublicKey(playerTwoBattle), isSigner: false, isWritable: true },
    { pubkey: serverAuthority.publicKey, isSigner: true, isWritable: false },
    { pubkey: new PublicKey(playerOne), isSigner: false, isWritable: false },
    { pubkey: new PublicKey(playerTwo), isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];

  const ix = new TransactionInstruction({
    programId: new PublicKey(programId),
    keys,
    data,
  });

  const tx = new Transaction().add(ix);
  tx.feePayer = serverAuthority.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  tx.sign(serverAuthority);

  const txid = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction(txid, 'confirmed');
  return txid;
}

// Server-side forfeit_battle contract call
async function forfeitBattleOnChain({ battle, winnerPlayerPubkey, programId, rpcUrl }) {
  const connection = new Connection(rpcUrl, 'confirmed');
  const discriminator = getInstructionDiscriminator('forfeit_battle');
  
  // Serialize winner public key (32 bytes)
  const winnerBuffer = new PublicKey(winnerPlayerPubkey).toBytes();
  const data = Buffer.concat([discriminator, winnerBuffer]);

  const keys = [
    { pubkey: new PublicKey(battle), isSigner: false, isWritable: true },
    { pubkey: new PublicKey(winnerPlayerPubkey), isSigner: false, isWritable: true },
    { pubkey: serverAuthority.publicKey, isSigner: true, isWritable: false },
  ];

  const ix = new TransactionInstruction({
    programId: new PublicKey(programId),
    keys,
    data,
  });

  const tx = new Transaction().add(ix);
  tx.feePayer = serverAuthority.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  tx.sign(serverAuthority);

  const txid = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction(txid, 'confirmed');
  return txid;
}

// Server-side resolve_battle contract call
async function resolveBattleOnChain({ battle, winnerPlayerPubkey, programId, rpcUrl }) {
  const connection = new Connection(rpcUrl, 'confirmed');
  const discriminator = getInstructionDiscriminator('resolve_battle');
  
  // Serialize winner public key (32 bytes)
  const winnerBuffer = new PublicKey(winnerPlayerPubkey).toBytes();
  const data = Buffer.concat([discriminator, winnerBuffer]);

  const keys = [
    { pubkey: new PublicKey(battle), isSigner: false, isWritable: true },
    { pubkey: new PublicKey(winnerPlayerPubkey), isSigner: false, isWritable: true },
    { pubkey: serverAuthority.publicKey, isSigner: true, isWritable: false },
  ];

  const ix = new TransactionInstruction({
    programId: new PublicKey(programId),
    keys,
    data,
  });

  const tx = new Transaction().add(ix);
  tx.feePayer = serverAuthority.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  tx.sign(serverAuthority);

  const txid = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction(txid, 'confirmed');
  return txid;
}

function normalizePublicKey(pubkey) {
  if (!pubkey) return '';
  if (typeof pubkey === 'string') return pubkey.trim();
  if (pubkey.toBase58) return pubkey.toBase58();
  if (pubkey.toString) return pubkey.toString().trim();
  if (Buffer.isBuffer(pubkey)) return bs58.encode(pubkey);
  return String(pubkey).trim();
}

function comparePublicKeys(a, b) {
  const normA = normalizePublicKey(a);
  const normB = normalizePublicKey(b);
  console.log(`[SERVER] Comparing pubkeys:`, normA, normB, 'equal:', normA === normB);
  return normA === normB;
}

io.on('connection', (socket) => {
  console.log(`[SERVER] Connected: ${socket.id}`)

  // When a player joins the queue, they must send their wallet and battle account pubkeys
  socket.on('join_queue', (data) => {
    // data: { characterName, walletPubkey, battleAccountPubkey }
    console.log(`[SERVER] ${socket.id} joined queue with character: ${data?.characterName}`);
    queue.push({
      socket,
      characterName: data?.characterName,
      walletPubkey: data?.walletPubkey,
      battleAccountPubkey: data?.battleAccountPubkey
    });

    // Try to match if 2+ in queue
    if (queue.length >= 2) {
      const [p1, p2] = queue.splice(0, 2);
      pairs.set(p1.socket.id, p2.socket.id);
      pairs.set(p2.socket.id, p1.socket.id);

      // Store battle info for resolution
      // Both players should use the master battle account (Player 1's battle)
      const masterBattleAccount = p1.battleAccountPubkey;
      pairs.set(`${p1.socket.id}_battle`, masterBattleAccount);
      pairs.set(`${p2.socket.id}_battle`, masterBattleAccount); // Use same master battle
      pairs.set(`${p1.socket.id}_wallet`, p1.walletPubkey);
      pairs.set(`${p2.socket.id}_wallet`, p2.walletPubkey);

      // Call joinBattleOnChain with real accounts
      joinBattleOnChain({
        battle: p1.battleAccountPubkey,
        playerTwoBattle: p2.battleAccountPubkey,
        playerOne: p1.walletPubkey,
        playerTwo: p2.walletPubkey,
        programId: PROGRAM_ID,
        rpcUrl: RPC_URL
      })
      .then(async sig => {
        console.log('[SERVER] join_battle tx:', sig);
        try {
          // Fetch and decode battle account
          const connection = new Connection(RPC_URL, 'confirmed');
          const battleAccountInfo = await connection.getAccountInfo(new PublicKey(p1.battleAccountPubkey));
          if (!battleAccountInfo) throw new Error('Battle account not found on-chain');
          const battleState = decodeBattleAccount(battleAccountInfo.data);
          console.log('[SERVER] Battle state:', battleState);
          
          // Store battle deadline for auto-resolution
          const deadline = new Date(battleState.deadline * 1000);
          battleDeadlines.set(p1.battleAccountPubkey, {
            deadline: deadline,
            battleAccount: p1.battleAccountPubkey,
            player1: p1.walletPubkey,
            player2: p2.walletPubkey,
            socket1: p1.socket.id,
            socket2: p2.socket.id,
            player1Health: 100,
            player2Health: 100
          });
          
          // Notify both players that the battle is ready and send state
          const battleReadyPayload = {
            joinBattleTx: sig,
            battle: p1.battleAccountPubkey,
            playerTwoBattle: p2.battleAccountPubkey,
            playerOne: p1.walletPubkey,
            playerTwo: p2.walletPubkey,
            characterOne: p1.characterName,
            characterTwo: p2.characterName
          };
          p1.socket.emit('battle_ready', battleReadyPayload);
          p2.socket.emit('battle_ready', battleReadyPayload);
          p1.socket.emit('battle_state', battleState);
          p2.socket.emit('battle_state', battleState);
        } catch (err) {
          console.error('[SERVER] Error fetching or decoding battle state:', err);
          p1.socket.emit('match_error', { error: 'Failed to fetch battle state: ' + err.message });
          p2.socket.emit('match_error', { error: 'Failed to fetch battle state: ' + err.message });
        }
      })
      .catch(err => {
        console.error('[SERVER] join_battle error:', err);
        p1.socket.emit('match_error', { error: err.message });
        p2.socket.emit('match_error', { error: err.message });
      });

      console.log(`[SERVER] Matched ${p1.socket.id} <-> ${p2.socket.id}`);
    }

    // In join_queue handler, after receiving data:
    socketWallets.set(socket.id, data?.walletPubkey);
  })

  socket.on('player_state', (data) => {
    const opponentId = pairs.get(socket.id)
    if (opponentId) {
    console.log(`[SERVER] player_state from ${socket.id} to ${opponentId}:`, data)
      io.to(opponentId).emit('opponent_state', data)
      const battleAccount = pairs.get(`${socket.id}_battle`);
      const battleInfo = battleDeadlines.get(battleAccount);
      if (battleInfo) {
        if (socket.id === battleInfo.socket1) {
          battleInfo.player1Health = typeof data.health === 'number' ? data.health : battleInfo.player1Health;
        } else if (socket.id === battleInfo.socket2) {
          battleInfo.player2Health = typeof data.health === 'number' ? data.health : battleInfo.player2Health;
        }
      }
    } else {
      console.warn(`[SERVER] player_state from ${socket.id} to undefined (no opponent):`, data)
    }
  })

  socket.on('deal_damage', ({ amount }) => {
    const opponentId = pairs.get(socket.id)
    console.log(`[SERVER] deal_damage from ${socket.id} to ${opponentId}: amount=${amount}`)
    if (opponentId) io.to(opponentId).emit('take_damage', amount)
  })

  socket.on('game_end', (result) => {
    const opponentId = pairs.get(socket.id)
    console.log(`[SERVER] game_end from ${socket.id} to ${opponentId}:`, result)
    
    if (!opponentId) {
      console.warn(`[SERVER] game_end from ${socket.id} to undefined (no opponent):`, result);
      return;
    }
    
    // Check if this is an early defeat notification
    if (result.earlyDefeat) {
      console.log(`[SERVER] Early defeat detected, countdown time: ${result.countdownTime}s`);
      io.to(opponentId).emit('opponent_game_end', result);
      return;
    }
    
    // Handle tie scenario (both players lose simultaneously)
    if (result.tie) {
      console.log(`[SERVER] Tie detected - both players lost simultaneously`);
      // Both players store the same master battle account
      const battleAccount = pairs.get(`${socket.id}_battle`);
      const winnerWallet = pairs.get(`${socket.id}_wallet`);
      
      // Check if already processed
      if (processedBattles.has(battleAccount)) {
        console.log(`[SERVER] Battle ${battleAccount} already processed, skipping`);
        return;
      }
      
      if (battleAccount && winnerWallet) {
        processedBattles.add(battleAccount);
        console.log(`[SERVER] Using battle account for tie resolution: ${battleAccount}`);
        resolveBattleOnChain({
          battle: battleAccount,
          winnerPlayerPubkey: winnerWallet,
          programId: PROGRAM_ID,
          rpcUrl: RPC_URL
        })
        .then(txid => {
          console.log('[SERVER] tie resolve_battle tx:', txid);
          const isWinner = comparePublicKeys(winnerWallet, pairs.get(`${socket.id}_wallet`));
          io.to(socket.id).emit('battle_resolved', { 
            transactionId: txid,
            winner: winnerWallet,
            won: isWinner,
            message: isWinner ? 'Tie resolved - you won by technical decision!' : 'Tie resolved - opponent won by technical decision!'
          });
          io.to(opponentId).emit('battle_resolved', { 
            transactionId: txid,
            winner: winnerWallet,
            won: !isWinner,
            message: isWinner ? 'Tie resolved - opponent won by technical decision!' : 'Tie resolved - you won by technical decision!'
          });
        })
        .catch(err => {
          console.error('[SERVER] tie resolve_battle error:', err);
          io.to(socket.id).emit('battle_resolution_error', { 
            error: 'Failed to resolve tie on-chain: ' + err.message
          });
          io.to(opponentId).emit('battle_resolution_error', { 
            error: 'Failed to resolve tie on-chain: ' + err.message
          });
        })
        .finally(() => {
          // Clean up pairs
          pairs.delete(opponentId);
          pairs.delete(socket.id);
          pairs.delete(`${socket.id}_battle`);
          pairs.delete(`${opponentId}_battle`);
          pairs.delete(`${socket.id}_wallet`);
          pairs.delete(`${opponentId}_wallet`);
          battleDeadlines.delete(battleAccount);
        });
      }
      return;
    }
    
    // Determine winner based on game result
    const winnerWallet = result.winner === 'player1' ? 
      pairs.get(`${socket.id}_wallet`) : 
      pairs.get(`${opponentId}_wallet`);
    
    // Both players store the same master battle account
    const battleAccount = pairs.get(`${socket.id}_battle`);
    
    // Check if already processed
    if (processedBattles.has(battleAccount)) {
      console.log(`[SERVER] Battle ${battleAccount} already processed, skipping`);
      return;
    }
    
    if (battleAccount && winnerWallet) {
      processedBattles.add(battleAccount);
      console.log(`[SERVER] Using battle account for resolution: ${battleAccount}`);
      console.log(`[SERVER] Winner wallet: ${winnerWallet}`);
      
      // Call resolve_battle on-chain
      resolveBattleOnChain({
        battle: battleAccount,
        winnerPlayerPubkey: winnerWallet,
        programId: PROGRAM_ID,
        rpcUrl: RPC_URL
      })
      .then(txid => {
        console.log('[SERVER] game_end resolve_battle tx:', txid);
        // Notify both players of the resolution with appropriate messages
        const isWinner = comparePublicKeys(winnerWallet, pairs.get(`${socket.id}_wallet`));
        io.to(socket.id).emit('battle_resolved', { 
          transactionId: txid,
          winner: winnerWallet,
          won: isWinner,
          message: isWinner ? 'Victory! You won the battle!' : 'Defeat! You lost the battle!'
        });
        io.to(opponentId).emit('battle_resolved', { 
          transactionId: txid,
          winner: winnerWallet,
          won: !isWinner,
          message: isWinner ? 'Defeat! You lost the battle!' : 'Victory! You won the battle!'
        });
      })
      .catch(err => {
        console.error('[SERVER] game_end resolve_battle error:', err);
        // Notify players of resolution failure
        io.to(socket.id).emit('battle_resolution_error', { 
          error: 'Failed to resolve battle on-chain: ' + err.message
        });
        io.to(opponentId).emit('battle_resolution_error', { 
          error: 'Failed to resolve battle on-chain: ' + err.message
        });
      })
      .finally(() => {
        // Clean up pairs
        pairs.delete(opponentId);
        pairs.delete(socket.id);
        pairs.delete(`${socket.id}_battle`);
        pairs.delete(`${opponentId}_battle`);
        pairs.delete(`${socket.id}_wallet`);
        pairs.delete(`${opponentId}_wallet`);
        // Clean up deadline tracking
        battleDeadlines.delete(battleAccount);
      });
    } else {
      console.error('[SERVER] Missing battle info for game_end resolve_battle');
      // Fallback: try to fetch the battle account and determine the winner
      if (battleAccount) {
        const connection = new Connection(RPC_URL, 'confirmed');
        connection.getAccountInfo(new PublicKey(battleAccount)).then(battleAccountInfo => {
          if (battleAccountInfo) {
            const battleState = decodeBattleAccount(battleAccountInfo.data);
            const winnerPubkey = battleState.winner;
            const playerPubkeys = battleState.players;
            // For each socket, try to get wallet pubkey from pairs, else use playerPubkeys
            [socket.id, opponentId].forEach((id, idx) => {
              if (!id) return;
              let playerWallet = pairs.get(`${id}_wallet`);
              if (!playerWallet) {
                playerWallet = socketWallets.get(id);
              }
              if (!playerWallet) {
                io.to(id).emit('battle_resolved', {
                  winner: winnerPubkey,
                  won: false,
                  message: 'Battle ended, but your wallet could not be matched to the winner.'
                });
                return;
              }
              console.log(`[SERVER] Comparing playerWallet: ${playerWallet} to winnerPubkey: ${winnerPubkey}`);
              const won = comparePublicKeys(playerWallet, winnerPubkey);
              io.to(id).emit('battle_resolved', {
                winner: winnerPubkey,
                won,
                message: won ? 'Victory! You won the battle!' : 'Defeat! You lost the battle!'
              });
            });
          } else {
            // If we can't fetch the battle account, just notify the player of an unknown result
            io.to(socket.id).emit('battle_resolved', {
              winner: null,
              won: false,
              message: 'Battle ended, but winner could not be determined.'
            });
            if (opponentId) {
              io.to(opponentId).emit('battle_resolved', {
                winner: null,
                won: false,
                message: 'Battle ended, but winner could not be determined.'
              });
            }
          }
        }).catch(err => {
          console.error('[SERVER] Error fetching battle account for fallback:', err);
          io.to(socket.id).emit('battle_resolved', {
            winner: null,
            won: false,
            message: 'Battle ended, but winner could not be determined.'
          });
          if (opponentId) {
            io.to(opponentId).emit('battle_resolved', {
              winner: null,
              won: false,
              message: 'Battle ended, but winner could not be determined.'
            });
          }
        });
      } else {
        // No battle account info at all
        io.to(socket.id).emit('battle_resolved', {
          winner: null,
          won: false,
          message: 'Battle ended, but winner could not be determined.'
        });
        if (opponentId) {
          io.to(opponentId).emit('battle_resolved', {
            winner: null,
            won: false,
            message: 'Battle ended, but winner could not be determined.'
          });
        }
      }
    }
  })

  socket.on('forfeit', () => {
    const opponentId = pairs.get(socket.id)
    console.log(`[SERVER] forfeit from ${socket.id} to ${opponentId}`)
    if (opponentId) {
      // Both players store the same master battle account
      const battleAccount = pairs.get(`${socket.id}_battle`);
      const winnerWallet = pairs.get(`${opponentId}_wallet`);
      
      if (battleAccount && winnerWallet) {
        // Check if already processed
        if (processedBattles.has(battleAccount)) {
          console.log(`[SERVER] Battle ${battleAccount} already processed, skipping forfeit`);
          return;
        }
        
        processedBattles.add(battleAccount);
        console.log(`[SERVER] Using battle account for forfeit: ${battleAccount}`);
        // Call forfeit_battle on-chain
        forfeitBattleOnChain({
          battle: battleAccount,
          winnerPlayerPubkey: winnerWallet,
          programId: PROGRAM_ID,
          rpcUrl: RPC_URL
        })
        .then(txid => {
          console.log('[SERVER] forfeit_battle tx:', txid);
      // Notify opponent: they win
          io.to(opponentId).emit('opponent_game_end', { 
            won: true, 
            message: 'Your opponent forfeited. You win!',
            transactionId: txid
          });
      // Notify leaver: they lose
          io.to(socket.id).emit('opponent_game_end', { 
            won: false, 
            message: 'You forfeited the match and lost your stake.',
            transactionId: txid
          });
        })
        .catch(err => {
          console.error('[SERVER] forfeit_battle error:', err);
          // Still notify players even if contract call fails
          io.to(opponentId).emit('opponent_game_end', { 
            won: true, 
            message: 'Your opponent forfeited. You win! (Contract resolution pending)'
          });
          io.to(socket.id).emit('opponent_game_end', { 
            won: false, 
            message: 'You forfeited the match and lost your stake. (Contract resolution pending)'
          });
        })
        .finally(() => {
          // Clean up pairs
          pairs.delete(opponentId);
          pairs.delete(socket.id);
          pairs.delete(`${socket.id}_battle`);
          pairs.delete(`${opponentId}_battle`);
          pairs.delete(`${socket.id}_wallet`);
          pairs.delete(`${opponentId}_wallet`);
          // Clean up deadline tracking
          battleDeadlines.delete(battleAccount);
        });
      } else {
        console.error('[SERVER] Missing battle info for forfeit');
        // Fallback notification without contract call
        io.to(opponentId).emit('opponent_game_end', { won: true, message: 'Your opponent forfeited. You win!' });
        io.to(socket.id).emit('opponent_game_end', { won: false, message: 'You forfeited the match and lost your stake.' });
        pairs.delete(opponentId);
        pairs.delete(socket.id);
      }
    }
  })

  socket.on('disconnect', () => {
    // Remove from queue
    const idx = queue.findIndex(p => p.socket.id === socket.id)
    if (idx !== -1) queue.splice(idx, 1)

    // Notify opponent if paired (treat as forfeit)
    const opponentId = pairs.get(socket.id)
    if (opponentId) {
      // Both players store the same master battle account
      const battleAccount = pairs.get(`${socket.id}_battle`);
      const winnerWallet = pairs.get(`${opponentId}_wallet`);
      
      if (battleAccount && winnerWallet) {
        // Check if already processed
        if (processedBattles.has(battleAccount)) {
          console.log(`[SERVER] Battle ${battleAccount} already processed, skipping disconnect forfeit`);
          return;
        }
        
        processedBattles.add(battleAccount);
        console.log(`[SERVER] Using battle account for disconnect forfeit: ${battleAccount}`);
        // Call forfeit_battle on-chain for disconnect
        forfeitBattleOnChain({
          battle: battleAccount,
          winnerPlayerPubkey: winnerWallet,
          programId: PROGRAM_ID,
          rpcUrl: RPC_URL
        })
        .then(txid => {
          console.log('[SERVER] disconnect forfeit_battle tx:', txid);
          io.to(opponentId).emit('opponent_game_end', { 
            won: true, 
            message: 'Your opponent disconnected. You win!',
            transactionId: txid
          });
        })
        .catch(err => {
          console.error('[SERVER] disconnect forfeit_battle error:', err);
          io.to(opponentId).emit('opponent_game_end', { 
            won: true, 
            message: 'Your opponent disconnected. You win! (Contract resolution pending)'
          });
        })
        .finally(() => {
          // Clean up pairs
          pairs.delete(opponentId);
          pairs.delete(socket.id);
          pairs.delete(`${socket.id}_battle`);
          pairs.delete(`${opponentId}_battle`);
          pairs.delete(`${socket.id}_wallet`);
          pairs.delete(`${opponentId}_wallet`);
          // Clean up deadline tracking
          battleDeadlines.delete(battleAccount);
          console.log(`[SERVER] ${socket.id} disconnected, notified ${opponentId}`);
        });
      } else {
        // Fallback notification
        io.to(opponentId).emit('opponent_disconnected');
        pairs.delete(opponentId);
        pairs.delete(socket.id);
        console.log(`[SERVER] ${socket.id} disconnected, notified ${opponentId}`);
      }
    } else {
      console.log(`[SERVER] Disconnected: ${socket.id}`)
    }

    // In disconnect handler, add:
    socketWallets.delete(socket.id);
  })

  // Catch-all for debugging
  socket.onAny((event, ...args) => {
    if (!['player_state', 'deal_damage', 'game_end', 'join_queue', 'disconnect'].includes(event)) {
      console.log(`[SERVER] Event '${event}' from ${socket.id}:`, ...args)
    }
  })
})

// Periodic check for expired battles (every 30 seconds)
setInterval(() => {
  const now = new Date();
  for (const [battleAccount, battleInfo] of battleDeadlines.entries()) {
    if (now >= battleInfo.deadline) {
      console.log(`[SERVER] Battle ${battleAccount} expired, auto-resolving...`);
      
      // Check if already processed
      if (processedBattles.has(battleAccount)) {
        console.log(`[SERVER] Battle ${battleAccount} already processed, skipping auto-resolve`);
        battleDeadlines.delete(battleAccount);
        continue;
      }
      
      processedBattles.add(battleAccount);
      
      // Get last known health for both players (assume battleInfo.player1Health and battleInfo.player2Health are tracked)
      let winnerPlayerPubkey, winnerSocketId, loserSocketId;
      if (battleInfo.player1Health > battleInfo.player2Health) {
        winnerPlayerPubkey = battleInfo.player1;
        winnerSocketId = battleInfo.socket1;
        loserSocketId = battleInfo.socket2;
      } else if (battleInfo.player2Health > battleInfo.player1Health) {
        winnerPlayerPubkey = battleInfo.player2;
        winnerSocketId = battleInfo.socket2;
        loserSocketId = battleInfo.socket1;
      } else {
        // Tie: fallback to player1 as winner
        winnerPlayerPubkey = battleInfo.player1;
        winnerSocketId = battleInfo.socket1;
        loserSocketId = battleInfo.socket2;
      }
      resolveBattleOnChain({
        battle: battleAccount,
        winnerPlayerPubkey: winnerPlayerPubkey,
        programId: PROGRAM_ID,
        rpcUrl: RPC_URL
      })
      .then(txid => {
        console.log('[SERVER] Auto-resolve battle tx:', txid);
        io.to(winnerSocketId).emit('battle_resolved', {
          transactionId: txid,
          winner: winnerPlayerPubkey,
          won: true,
          message: 'Victory! Battle expired - you won by having more health!'
        });
        io.to(loserSocketId).emit('battle_resolved', {
          transactionId: txid,
          winner: winnerPlayerPubkey,
          won: false,
          message: 'Defeat! Battle expired - you lost by having less health.'
        });
        console.log(`[SERVER] Auto-resolve notifications sent - Winner: ${winnerPlayerPubkey}`);
      })
      .catch(err => {
        console.error('[SERVER] Auto-resolve battle error:', err);
        io.to(battleInfo.socket1).emit('battle_resolution_error', {
          error: 'Auto-resolution failed: ' + err.message
        });
        io.to(battleInfo.socket2).emit('battle_resolution_error', {
          error: 'Auto-resolution failed: ' + err.message
        });
      })
      .finally(() => {
        // Clean up
        battleDeadlines.delete(battleAccount);
        pairs.delete(battleInfo.socket1);
        pairs.delete(battleInfo.socket2);
        pairs.delete(`${battleInfo.socket1}_battle`);
        pairs.delete(`${battleInfo.socket2}_battle`);
        pairs.delete(`${battleInfo.socket1}_wallet`);
        pairs.delete(`${battleInfo.socket2}_wallet`);
      });
    }
  }
}, 30000); // Check every 30 seconds

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`[SERVER] Matchmaking server running on port ${PORT}`);
  console.log('[SERVER] Using PROGRAM_ID:', PROGRAM_ID)
  console.log('[SERVER] Using RPC_URL:', RPC_URL)
}); 