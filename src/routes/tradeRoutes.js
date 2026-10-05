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
  acknowledgeTradeNotification,
  cancelPlayerListing,
  cancelPurchaseRequest,
  cancelTradeOffer,
  createTradeOffer,
  createPlayerListing,
  getTradeRoom,
  getPlayerMarket,
  getTeamTradeOffers,
  getTradeWindow,
  requestPlayerPurchase,
  respondToPurchaseRequest,
  respondToTradeOffer,
} from "../services/tradeService.js";

const router = express.Router();
const offerSchema = z.object({
  toTeamId: z.string().uuid(),
  offeredPlayerId: z.string().uuid(),
  requestedPlayerId: z.string().uuid(),
  cashAmount: z.number().finite().min(0).default(0),
});
const listingSchema = z.object({
  playerId: z.string().uuid(),
  askingPrice: z.number().finite().positive(),
});
const responseSchema = z.object({ accepted: z.boolean() });
const uuidSchema = z.string().uuid();

const emitTradeUpdate = (req, teamIds = []) => {
  const io = req.app.get("io");
  for (const teamId of new Set(teamIds.filter(Boolean))) {
    io?.to(`team:${teamId}`).emit("trade_offer_updated");
  }
};

const emitMarketUpdate = (req, teamIds = []) => {
  req.app.get("io")?.to("auction-room").emit("trade_market_updated");
  emitTradeUpdate(req, teamIds);
};

router.get(
  "/state",
  authMiddleware,
  requireRole("PARTICIPANT"),
  requireTeamAccess,
  requireApprovedTeam,
  async (req, res) =>
    successResponse(res, await getTradeRoom(req.user.teamId)),
);

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
      emitTradeUpdate(req, [req.user.teamId, payload.toTeamId]);
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

router.get(
  "/market",
  authMiddleware,
  requireRole("PARTICIPANT"),
  requireTeamAccess,
  requireApprovedTeam,
  async (req, res) =>
    successResponse(res, {
      market: await getPlayerMarket(req.user.teamId),
    }),
);

router.post(
  "/market/listings",
  authMiddleware,
  requireRole("PARTICIPANT"),
  requireTeamAccess,
  requireApprovedTeam,
  async (req, res) => {
    try {
      const payload = listingSchema.parse(req.body);
      const listing = await createPlayerListing({
        teamId: req.user.teamId,
        ...payload,
      });
      emitMarketUpdate(req, [req.user.teamId]);
      return successResponse(res, { listing }, 201);
    } catch (error) {
      return errorResponse(
        res,
        error.message || "Unable to list player",
        400,
        "PLAYER_LISTING_FAILED",
      );
    }
  },
);

router.delete(
  "/market/listings/:listingId",
  authMiddleware,
  requireRole("PARTICIPANT"),
  requireTeamAccess,
  requireApprovedTeam,
  async (req, res) => {
    try {
      const listingId = uuidSchema.parse(req.params.listingId);
      const listing = await cancelPlayerListing({
        teamId: req.user.teamId,
        listingId,
      });
      emitMarketUpdate(req, [req.user.teamId]);
      return successResponse(res, { listing });
    } catch (error) {
      return errorResponse(
        res,
        error.message || "Unable to cancel listing",
        400,
        "PLAYER_LISTING_CANCEL_FAILED",
      );
    }
  },
);

router.post(
  "/market/listings/:listingId/requests",
  authMiddleware,
  requireRole("PARTICIPANT"),
  requireTeamAccess,
  requireApprovedTeam,
  async (req, res) => {
    try {
      const listingId = uuidSchema.parse(req.params.listingId);
      const request = await requestPlayerPurchase({
        teamId: req.user.teamId,
        listingId,
      });
      emitTradeUpdate(req, [request.buyer_team_id, request.seller_team_id]);
      return successResponse(res, { request }, 201);
    } catch (error) {
      return errorResponse(
        res,
        error.message || "Unable to request purchase",
        400,
        "PLAYER_PURCHASE_REQUEST_FAILED",
      );
    }
  },
);

router.post(
  "/market/requests/:requestId/respond",
  authMiddleware,
  requireRole("PARTICIPANT"),
  requireTeamAccess,
  requireApprovedTeam,
  async (req, res) => {
    try {
      const requestId = uuidSchema.parse(req.params.requestId);
      const { accepted } = responseSchema.parse(req.body);
      const request = await respondToPurchaseRequest({
        teamId: req.user.teamId,
        requestId,
        accept: accepted,
      });
      if (request.expired) {
        emitTradeUpdate(req, [request.seller_team_id, request.buyer_team_id]);
        return errorResponse(res, "This request expired and was automatically rejected", 410, "TRADE_REQUEST_EXPIRED");
      }
      if (accepted) {
        emitMarketUpdate(req, [request.seller_team_id, request.buyer_team_id]);
      } else {
        emitTradeUpdate(req, [request.seller_team_id, request.buyer_team_id]);
      }
      if (accepted)
        req.app.get("io")?.to("auction-room").emit("team_rosters_updated");
      return successResponse(res, { request });
    } catch (error) {
      return errorResponse(
        res,
        error.message || "Unable to respond to purchase request",
        400,
        "PLAYER_PURCHASE_RESPONSE_FAILED",
      );
    }
  },
);

router.post(
  "/market/requests/:requestId/acknowledge",
  authMiddleware,
  requireRole("PARTICIPANT"),
  requireTeamAccess,
  requireApprovedTeam,
  async (req, res) => {
    try {
      const requestId = uuidSchema.parse(req.params.requestId);
      const result = await acknowledgeTradeNotification({
        teamId: req.user.teamId,
        type: "purchase",
        id: requestId,
      });
      return successResponse(res, result);
    } catch (error) {
      return errorResponse(
        res,
        error.message || "Unable to acknowledge purchase request",
        400,
        "PLAYER_PURCHASE_ACK_FAILED",
      );
    }
  },
);

router.delete(
  "/market/requests/:requestId",
  authMiddleware,
  requireRole("PARTICIPANT"),
  requireTeamAccess,
  requireApprovedTeam,
  async (req, res) => {
    try {
      const requestId = uuidSchema.parse(req.params.requestId);
      const request = await cancelPurchaseRequest({
        teamId: req.user.teamId,
        requestId,
      });
      emitMarketUpdate(req, [req.user.teamId]);
      return successResponse(res, { request });
    } catch (error) {
      return errorResponse(
        res,
        error.message || "Unable to cancel purchase request",
        400,
        "PLAYER_PURCHASE_CANCEL_FAILED",
      );
    }
  },
);

router.post(
  "/offers/:offerId/respond",
  authMiddleware,
  requireRole("PARTICIPANT"),
  requireTeamAccess,
  requireApprovedTeam,
  async (req, res) => {
    try {
      const offerId = uuidSchema.parse(req.params.offerId);
      const { accepted } = responseSchema.parse(req.body);
      const offer = await respondToTradeOffer({
        teamId: req.user.teamId,
        offerId,
        accept: accepted,
      });
      if (offer.expired) {
        emitMarketUpdate(req, [offer.from_team_id, offer.to_team_id]);
        return errorResponse(res, "This request expired and was automatically rejected", 410, "TRADE_REQUEST_EXPIRED");
      }
      const io = req.app.get("io");
      emitTradeUpdate(req, [offer.from_team_id, offer.to_team_id]);
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

router.post(
  "/offers/:offerId/acknowledge",
  authMiddleware,
  requireRole("PARTICIPANT"),
  requireTeamAccess,
  requireApprovedTeam,
  async (req, res) => {
    try {
      const offerId = uuidSchema.parse(req.params.offerId);
      const result = await acknowledgeTradeNotification({
        teamId: req.user.teamId,
        type: "swap",
        id: offerId,
      });
      return successResponse(res, result);
    } catch (error) {
      return errorResponse(
        res,
        error.message || "Unable to acknowledge trade offer",
        400,
        "TRADE_OFFER_ACK_FAILED",
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
      emitTradeUpdate(req, [offer.from_team_id, offer.to_team_id]);
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
