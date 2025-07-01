# Daughters of Aether – Matchmaking & Battle Server

This is the backend server for Daughters of Aether, responsible for matchmaking, battle state, and contract integration with Solana.

## Features

- **Matchmaking:** Pairs players for PvP battles.
- **Contract Integration:** Handles all Solana contract calls (join, resolve, forfeit, cancel).
- **State Sync:** Tracks player health, deadlines, and battle state.
- **Auto-Resolution:** Automatically resolves battles on timeout or disconnect.
- **Dynamic Environment:** Automatically selects program ID and RPC URL based on NODE_ENV (development/production).
- **CORS:** Configurable allowed origins for WebSocket connections.
- **Robust Error Handling:** Handles edge cases and logs errors for debugging.

## Getting Started

1. **Install dependencies:**
   ```sh
   pnpm install
   ```
2. **Set environment variables:**
   - See [Environment Variables](#environment-variables) below for required variables in each environment.
3. **Run the server:**
   ```sh
   node matchmaking.cjs
   ```

## Environment Variables

### Common
- `SERVER_AUTH_KEYPAIR` – JSON array of the server authority secret key (keep this secret!)
- `ALLOWED_ORIGINS` – Comma-separated list of allowed frontend origins for CORS (e.g. `http://localhost:3000,https://daughter-of-aether.vercel.app`)
- `PORT` – Port to listen on (default: 10000)

### Development (Solana Devnet)
- `NODE_ENV=development`
- `DEVELOPMENT_PROGRAM_ID` – Solana devnet program ID (e.g. `5RV8MAYjHoSb16VkqjqN5KGX139MULDR6GHuYhxettKT`)
- `SOLANA_DEVNET_RPC_URL` – Devnet RPC endpoint (e.g. `https://api.devnet.solana.com`)

### Production (Gorbagana Testnet)
- `NODE_ENV=production`
- `PRODUCTION_PROGRAM_ID` – Gorbagana program ID (e.g. `GAB3CVmCbarpepefKNFEGEUGw6RzcMx9LSGER2Hg3FU2`)
- `GORBAGANA_RPC_URL` – Gorbagana RPC endpoint (e.g. `https://gorbagana-rpc-cors-proxy.skippstack.workers.dev/`)

#### Example `.env` for Development
```env
NODE_ENV=development
DEVELOPMENT_PROGRAM_ID=5RV8MAYjHoSb16VkqjqN5KGX139MULDR6GHuYhxettKT
SOLANA_DEVNET_RPC_URL=https://api.devnet.solana.com
SERVER_AUTH_KEYPAIR=[...]
ALLOWED_ORIGINS=http://localhost:3000
PORT=10000
```

#### Example `.env` for Production
```env
NODE_ENV=production
PRODUCTION_PROGRAM_ID=GAB3CVmCbarpepefKNFEGEUGw6RzcMx9LSGER2Hg3FU2
GORBAGANA_RPC_URL=https://gorbagana-rpc-cors-proxy.skippstack.workers.dev/
SERVER_AUTH_KEYPAIR=[...]
ALLOWED_ORIGINS=https://daughter-of-aether.vercel.app
PORT=10000
```

## Dynamic Environment Selection
- The server automatically selects the correct program ID and RPC URL based on `NODE_ENV`.
- You do **not** need to change code to switch between devnet and production—just set the right environment variables.
- On startup, the server logs the current environment, program ID, and RPC URL.

## Deployment
- **Persistent Node.js host required** (Railway, Render, Fly.io, Heroku, etc.).
- Not recommended for Vercel due to WebSocket requirements.
- Make sure to set all required environment variables in your deployment platform.
- Fund the server authority wallet with enough SOL/GOR to pay for transaction fees.

## Logging
- On startup, the server logs:
  - `NODE_ENV`
  - `PROGRAM_ID` in use
  - `RPC_URL` in use
  - (Optional) Server authority public key and balance
- All contract errors and important events are logged to the console.

## Tech Stack
- Node.js, Socket.IO, Solana web3.js, Borsh, Anchor IDL

## Security
- **Keep server authority keypair secret.**
- Only the server should perform contract calls requiring authority.
- Restrict allowed origins for CORS.

## Troubleshooting
- **Simulation failed: Attempt to debit an account but found no record of a prior credit.**
  - Fund the server authority wallet with SOL/GOR on the correct network.
- **Wrong program ID or network:**
  - Check your environment variables and logs at startup.
- **CORS errors:**
  - Make sure `ALLOWED_ORIGINS` includes your frontend URL.

---

For more details, see the code and comments in `matchmaking.cjs`.
