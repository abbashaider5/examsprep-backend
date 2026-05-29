# Deploy examsprep-backend to Vercel

Git pushes to `main` do **not** update production until Vercel builds the project.

## One-time Vercel project settings

1. Vercel dashboard → **examsprep-backend** → Settings → General  
   - **Root Directory:** `server` (if the repo is the monorepo `examprep`) **or** `.` if this repo is only the API  
2. Settings → Git → connect **abbashaider5/examsprep-backend** and enable **Production Branch: main**

## Deploy from your machine

```bash
cd server
npm install -g vercel
vercel login
vercel link
vercel deploy --prod
```

## Verify deploy

```bash
curl https://examsprep-backend.vercel.app/api/health
```

Look for `"apiVersion":"2026-05-29-pdf-text"` in the JSON.

## GitHub Actions (optional)

Add repo secrets: `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`  
Then pushes to `main` run `.github/workflows/deploy-vercel.yml`.
