import express from "express";
import { z } from "zod";
import {
  authMiddleware,
  requireRole,
  requireApprovedTeam,
  requireTeamAccess,
} from "../middleware/auth.js";
import { errorResponse, successResponse } from "../utils/response.js";
import {
  cancelTradeOffer,
  createTradeOffer,
  getTeamTradeOffers,
  getTradeWindow,
  respondToTradeOffer,
} from "../services/tradeService.js";

const router = express.Router();
const offerSchema = z.object({
  toTeamId: z.string().uuid(),
  offeredPlayerId: z.string().uuid(),
  requestedPlayerId: z.string().uuid(),
});
const responseSchema = z.object({ accepted: z.boolean() });
const uuidSchema = z.string().uuid();

router.get("/window", authMiddleware, async (_req, res) => {
  return successResponse(res, await getTradeWindow());
});

router.get(
  "/offers",
  authMiddleware,
  requireRole("PARTICIPANT"),
  requireTeamAccess,
  requireApprovedTeam,
  async (req, res) => {
    return successResponse(res, {
      offers: await getTeamTradeOffers(req.user.teamId),
    });
  },
);

router.post(
  "/offers",
  authMiddleware,
  requireRole("PARTICIPANT"),
  requireTeamAccess,
  requireApprovedTeam,
  async (req, res) => {
    try {
      const payload = offerSchema.parse(req.body);
      const offer = await createTradeOffer({
        fromTeamId: req.user.teamId,
        ...payload,
      });
      req.app
        .get("io")
        ?.to(`team:${payload.toTeamId}`)
        .emit("trade_offer_updated");
      return successResponse(res, { offer }, 201);
    } catch (error) {
      return errorResponse(
        res,
        error.message || "Unable to create trade offer",
        400,
        "TRADE_OFFER_FAILED",
      );
    }
  },
);

router.post(
  "/offers/:offerId/respond",
  authMiddleware,
  requireRole("PARTICIPANT"),
  requireTeamAccess,
  async (req, res) => {
    try {
      const offerId = uuidSchema.parse(req.params.offerId);
      const { accepted } = responseSchema.parse(req.body);
      const offer = await respondToTradeOffer({
        teamId: req.user.teamId,
        offerId,
        accept: accepted,
      });
      const io = req.app.get("io");
      io?.to(`team:${offer.from_team_id}`).emit("trade_offer_updated");
      io?.to(`team:${offer.to_team_id}`).emit("trade_offer_updated");
      if (accepted) io?.to("auction-room").emit("team_rosters_updated");
      return successResponse(res, { offer });
    } catch (error) {
      return errorResponse(
        res,
        error.message || "Unable to respond to trade offer",
        400,
        "TRADE_RESPONSE_FAILED",
      );
    }
  },
);

router.delete(
  "/offers/:offerId",
  authMiddleware,
  requireRole("PARTICIPANT"),
  requireTeamAccess,
  async (req, res) => {
    try {
      const offerId = uuidSchema.parse(req.params.offerId);
      const offer = await cancelTradeOffer({
        teamId: req.user.teamId,
        offerId,
      });
      req.app
        .get("io")
        ?.to(`team:${offer.to_team_id}`)
        .emit("trade_offer_updated");
      return successResponse(res, { offer });
    } catch (error) {
      return errorResponse(
        res,
        error.message || "Unable to cancel trade offer",
        400,
        "TRADE_CANCEL_FAILED",
      );
    }
  },
);

export default router;
