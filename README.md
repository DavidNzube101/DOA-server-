# Daughters of Aether – Matchmaking & Battle Server

This is the backend server for Daughters of Aether, responsible for matchmaking, battle state, and contract integration.

## Features

- **Matchmaking:** Pairs players for PvP battles.
- **Contract Integration:** Handles all Solana contract calls (join, resolve, forfeit, cancel).
- **State Sync:** Tracks player health, deadlines, and battle state.
- **Auto-Resolution:** Automatically resolves battles on timeout or disconnect.
- **Error Handling:** Robust error and edge case handling.

## Getting Started

1. **Install dependencies:**
   ```
   pnpm install
   ```
2. **Set environment variables:**  
   - `SOLANA_DEVNET_RPC_URL`
   - `DEVELOPMENT_PROGRAM_ID`
   - `SERVER_AUTH_KEYPAIR`
   - etc.

3. **Run the server:**
   ```
   node matchmaking.cjs
   ```

## Deployment

- **Persistent Node.js host required** (Railway, Render, Fly.io, Heroku, etc.).
- Not recommended for Vercel due to WebSocket requirements.

## Tech Stack

- Node.js, Socket.IO, Solana web3.js, Borsh, Anchor IDL

## Security

- Keep server authority keypair secret.
- Only server should perform contract calls requiring authority.
