import express from "express";
import { z } from "zod";
import { authMiddleware, requireRole } from "../middleware/auth.js";
import { query } from "../database/connection.js";
import { successResponse, errorResponse } from "../utils/response.js";

const router = express.Router();

const playerSchema = z.object({
  name: z.string().min(2),
  country: z.string().min(2),
  role: z.enum(["BATTER", "BOWLER", "ALL_ROUNDER", "WICKET_KEEPER"]),
  basePrice: z.number().min(0),
  isOverseas: z.boolean().optional(),
  isCaptain: z.boolean().optional(),
  franchise: z.string().min(2),
  photo: z.string().url().nullable().optional(),
});

router.get("/", authMiddleware, async (_req, res) => {
  const players = await query(
    "SELECT p.*, f.name AS franchise_name FROM players p LEFT JOIN ipl_franchises f ON f.id = p.franchise_id ORDER BY p.created_at DESC",
  );
  return successResponse(res, { players: players.rows });
});

router.post(
  "/",
  authMiddleware,
  requireRole("SUPER_ADMIN", "AUCTION_ADMIN"),
  async (req, res) => {
    try {
      const payload = playerSchema.parse({
        ...req.body,
        basePrice: Number(req.body.basePrice || 0),
        isOverseas: Boolean(req.body.isOverseas),
        isCaptain: Boolean(req.body.isCaptain),
      });

      const franchise = await query(
        "SELECT id FROM ipl_franchises WHERE name = $1 LIMIT 1",
        [payload.franchise],
      );
      if (franchise.rowCount === 0) {
        return errorResponse(
          res,
          "Franchise not found",
          400,
          "FRANCHISE_NOT_FOUND",
        );
      }

      const insert = await query(
        `INSERT INTO players (id, name, display_name, country, role, base_price, is_overseas, is_captain, franchise_id, photo, status)
      VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, 'AVAILABLE') RETURNING *`,
        [
          payload.name,
          payload.name,
          payload.country,
          payload.role,
          payload.basePrice,
          payload.isOverseas || false,
          payload.isCaptain || false,
          franchise.rows[0].id,
          payload.photo || null,
        ],
      );

      return successResponse(res, { player: insert.rows[0] }, 201);
    } catch (error) {
      return errorResponse(
        res,
        error.message || "Player creation failed",
        400,
        "PLAYER_CREATE_FAILED",
      );
    }
  },
);

export default router;
