# AnyCall - Permanent Deployment Guide

This guide will help you deploy AnyCall permanently using Vercel (frontend) + Railway (backend).

## Prerequisites

- Git repository (already initialized)
- Node.js 18+ installed
- npm or yarn package manager
- Accounts on [Vercel](https://vercel.com) and [Railway](https://railway.app)

## Deployment Steps

### Step 1: Deploy Backend to Railway

1. **Push to GitHub first** (required by Railway):
   ```bash
   git add .
   git commit -m "Add deployment configuration"
   git push origin main
   ```

2. **Create Railway project**:
   - Go to https://railway.app/new
   - Select "GitHub"
   - Choose your repository
   - Railway will automatically detect the server folder and deploy

3. **Get your Railway URL**:
   - After deployment, go to your Railway project
   - Click on "Deployments" → click on the latest deployment
   - Click "View Public URL" (should be something like `https://your-app-xxxx.up.railway.app`)

4. **Copy the URL** (you'll need it for Step 2)

### Step 2: Deploy Frontend to Vercel

1. **Install Vercel CLI** (if not already installed):
   ```bash
   npm install -g vercel
   ```

2. **Configure environment variables** in Vercel:
   - Go to https://vercel.com/dashboard
   - Create new project from your GitHub repo
   - Go to Project Settings → Environment Variables
   - Add: `VITE_SIGNALING_SERVER` = `https://your-railway-url.up.railway.app`

3. **Deploy to Vercel**:
   ```bash
   cd client
   npx vercel --prod
   ```

4. **Get your Vercel URL**:
   - Vercel will provide a URL like `https://your-app.vercel.app`

### Step 3: Update Client Configuration

The client is already configured to use the environment variable. Make sure:

1. In `client/.env.production`, update with your Railway URL:
   ```
   VITE_SIGNALING_SERVER=https://your-railway-url.up.railway.app
   ```

2. Rebuild the client:
   ```bash
   cd client
   npm run build
   ```

3. Redeploy to Vercel:
   ```bash
   npx vercel --prod
   ```

## Testing

Once deployed:
1. Open your Vercel URL in a browser
2. Open the same URL in another browser/tab (or use a different device)
3. Click "Start Auto-Call" on both tabs
4. The calls should connect successfully

## Troubleshooting

### CORS Errors
Make sure your Railway backend has CORS enabled (it already does in the code).

### Socket.IO Connection Issues
- Verify the `VITE_SIGNALING_SERVER` environment variable is set correctly
- Check Railway logs for any errors
- Ensure the Railway URL is accessible from the internet

### WebRTC Issues
- Make sure microphone permissions are granted
- Test with headphones to avoid feedback
- Check browser console for WebRTC errors

## Alternative: Use Render (Free Tier)

If Railway's free tier is limited, you can use Render:
1. Go to https://render.com
2. Create new "Web Service"
3. Connect your GitHub repository
4. Set root directory to `server`
5. Deploy

Then use the Render URL instead of Railway URL in Step 2.

## Cost

- **Vercel**: Free tier is sufficient for personal use
- **Railway**: $5/month for persistent containers (free trial available)
- **Render**: Free tier with limitations (services spin down after inactivity)

Total cost: **$0-5/month** depending on the platform you choose.
