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

export const env = {
  NODE_ENV: process.env.NODE_ENV || "development",
  PORT: Number(process.env.PORT || 5000),
  CLIENT_URL: process.env.CLIENT_URL || "http://localhost:5173",
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
