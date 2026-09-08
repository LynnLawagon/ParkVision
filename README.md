# ParkVision

ParkVision is a parking-lot monitoring prototype. It gives customers a live-style view of parking availability and gives parking personnel tools for reviewing stall status, alerts, and configured parking regions.

The repository now has one frontend application and one draft API:

```
frontend/   React + Vite interface
backend/    Express API with in-memory data
```

## Program Summary

The frontend currently runs independently with mock parking-lot data. Its main flows are:

- Customer view with available, occupied, and blocked parking stalls.
- Personnel sign-in screen.
- Personnel dashboard with stall totals and obstruction alerts.
- Region configuration view for defining parking-space areas.
- Shared visual components for stall grids, status chips, summaries, and legends.

The backend is a draft Express service intended to receive results from a future computer-vision or machine-learning service. It stores stall, alert, region, and audit data in memory, so all changes reset when the server restarts. The frontend is not connected to these API routes yet.

## Requirements

- Node.js 18 or newer
- npm

## Run the Program

Run the frontend and backend in separate terminals from the repository root.

### 1. Start the frontend

```powershell
cd frontend
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) in a browser. The frontend can be run by itself because it currently uses mock data.

### 2. Start the backend

In a second terminal:

```powershell
cd backend
npm install
npm start
```

The API listens on [http://localhost:4000](http://localhost:4000). Its health check is available at [http://localhost:4000/api/health](http://localhost:4000/api/health).

For automatic server restarts during backend development, use:

```powershell
npm run dev
```

The frontend and backend are separate processes. Starting the backend does not yet replace the frontend's mock data.

## Frontend Commands

Run these from `frontend/`:

```powershell
npm run dev       # Start the Vite development server
npm run build     # Create a production build in dist/
npm run preview   # Preview the production build locally
```

Important frontend locations:

- `src/App.jsx` - top-level application shell and screen switching.
- `src/screens/` - customer, login, personnel, and regions screens.
- `src/components/` - reusable parking-lot UI components.
- `src/data/mockData.js` - current placeholder parking data.
- `src/styles/tokens.js` - shared colors, spacing, and typography tokens.

## Backend API

| Method | Route | Purpose |
|---|---|---|
| `POST` | `/api/auth/login` | Authenticate personnel and return a JWT. |
| `GET` | `/api/stalls` | Return the current status of every stall. |
| `GET` | `/api/stalls/summary` | Return vacant, occupied, and blocked totals. |
| `PUT` | `/api/stalls/:id` | Update a stall classification from a CV/ML service. |
| `GET` | `/api/alerts` | Return current obstruction alerts. |
| `POST` | `/api/alerts/:id/acknowledge` | Acknowledge an alert. |
| `GET`, `POST`, `PATCH`, `DELETE` | `/api/regions` | Read and manage parking-space regions. |
| `GET` | `/api/regions/log` | Return the region-change audit log. |

The draft login credentials are username `j.cruz` and password `change-me`. Change these before using real data.

## Current Limitations

- The frontend uses mock data and is not yet wired to the backend.
- The backend uses an in-memory store; data is lost on restart.
- No camera ingestion or computer-vision service is included yet.
- Authentication and role checks are prototype-level only.
- The backend still needs production concerns such as a database, rate limiting, secure secrets, and HTTPS.
