#!/bin/bash

echo "=== AnyCall Deployment Script ==="
echo ""

# Check if we're in the right directory
if [ ! -f "client/package.json" ] || [ ! -f "server/package.json" ]; then
  echo "Error: Please run this script from the project root directory"
  exit 1
fi

# Install dependencies
echo "Installing dependencies..."
cd client && npm install && cd ..
cd server && npm install && cd ..

# Build client
echo "Building client..."
cd client && npm run build && cd ..

echo ""
echo "=== Deployment Complete ==="
echo "1. Frontend: Deploy 'client/dist' to Vercel"
echo "   Command: cd client && npx vercel --prod"
echo ""
echo "2. Backend: Deploy 'server' to Railway"
echo "   Visit: https://railway.app/new"
echo "   Or use CLI: railway up"
echo ""
echo "3. Update client/.env.production with your Railway URL"
