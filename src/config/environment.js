import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const candidatePaths = [
  path.resolve(__dirname, "../../../.env"),
  path.resolve(__dirname, "../../.env"),
  path.resolve(process.cwd(), ".env"),
];

for (const envPath of candidatePaths) {
  dotenv.config({ path: envPath });
}

const normalizeOrigin = (origin) => {
  try {
    return new URL(origin.trim()).origin;
  } catch {
    return null;
  }
};
const configuredClientOrigins = (
  process.env.CLIENT_URLS ||
  process.env.CLIENT_URL ||
  ""
)
  .split(",")
  .map(normalizeOrigin)
  .filter(Boolean);
const clientOrigins = [
  ...new Set([
    ...configuredClientOrigins,
    "https://rotaract-ipl.vercel.app",
    "http://localhost:5175",
    "http://localhost:5173",
  ]),
];

export const env = {
  NODE_ENV: process.env.NODE_ENV || "development",
  PORT: Number(process.env.PORT || 5002),
  CLIENT_URL: configuredClientOrigins[0] || "http://localhost:5175",
  CLIENT_URLS: clientOrigins,
  DATABASE_URL:
    process.env.DATABASE_URL ||
    "postgresql://postgres:postgres@localhost:5432/rotaract_ipl",
  JWT_SECRET: process.env.JWT_SECRET || "dev-secret-change-me",
  JWT_REFRESH_SECRET:
    process.env.JWT_REFRESH_SECRET || "dev-refresh-secret-change-me",
  SUPER_ADMIN_EMAIL:
    process.env.SUPER_ADMIN_EMAIL || "superadmin@rotaract.local",
  SUPER_ADMIN_PASSWORD: process.env.SUPER_ADMIN_PASSWORD || "SuperAdmin123!",
  AUCTION_ADMIN_EMAIL:
    process.env.AUCTION_ADMIN_EMAIL || "auctionadmin@rotaract.local",
  AUCTION_ADMIN_PASSWORD:
    process.env.AUCTION_ADMIN_PASSWORD || "AuctionAdmin123!",
};
