import { query, withTransaction } from "../database/connection.js";

const tradeWindowValue = async (client) => {
  const setting = await client.query(
    "SELECT value FROM game_settings WHERE key = 'trade_window_open'",
  );
  return setting.rows[0]?.value === true;
};

export const getTradeWindow = async () => {
  const result = await query(
    "SELECT value FROM game_settings WHERE key = 'trade_window_open'",
  );
  return { open: result.rows[0]?.value === true };
};

export const setTradeWindow = async ({ actorId, open }) =>
  withTransaction(async (client) => {
    await client.query(
      `INSERT INTO game_settings (key, value) VALUES ('trade_window_open', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [JSON.stringify(open)],
    );
    await client.query(
      `INSERT INTO audit_logs (actor_user_id, action, new_value)
       VALUES ($1, 'TRADE_WINDOW_UPDATED', $2::jsonb)`,
      [actorId, JSON.stringify({ open })],
    );
    return { open };
  });

export const getTeamRosters = async () => {
  const result = await query(
    `SELECT ct.id AS team_id, ct.name AS team_name,
       COUNT(DISTINCT tm.id)::int AS member_count,
       COALESCE(jsonb_agg(DISTINCT jsonb_build_object(
         'player_id', p.id,
         'name', p.name,
         'display_name', p.display_name,
         'photo', p.photo,
         'role', p.role,
         'country', p.country,
         'franchise_name', f.name,
         'acquired_price', s.acquired_price
       )) FILTER (WHERE s.player_id IS NOT NULL), '[]'::jsonb) AS players
     FROM college_teams ct
     LEFT JOIN team_members tm ON tm.team_id = ct.id
     LEFT JOIN squads s ON s.team_id = ct.id
     LEFT JOIN players p ON p.id = s.player_id
     LEFT JOIN ipl_franchises f ON f.id = p.franchise_id
     WHERE ct.status = 'ACTIVE'
     GROUP BY ct.id, ct.name
     ORDER BY ct.name`,
  );
  return result.rows;
};

export const getTeamTradeOffers = async (teamId) => {
  const result = await query(
    `SELECT tr.id, tr.from_team_id, tr.to_team_id, tr.status, tr.created_at,
       tr.cash_amount, tr.buyer_acknowledged_at,
       sender.name AS from_team_name, recipient.name AS to_team_name,
       offered.id AS offered_player_id, offered.display_name AS offered_player_name,
       offered.photo AS offered_player_photo,
       requested.id AS requested_player_id, requested.display_name AS requested_player_name,
       requested.photo AS requested_player_photo
     FROM trade_offers tr
     JOIN college_teams sender ON sender.id = tr.from_team_id
     JOIN college_teams recipient ON recipient.id = tr.to_team_id
     JOIN players offered ON offered.id = tr.offered_player_id
     JOIN players requested ON requested.id = tr.requested_player_id
     WHERE tr.from_team_id = $1 OR tr.to_team_id = $1
     ORDER BY tr.created_at DESC LIMIT 100`,
    [teamId],
  );
  return result.rows;
};

export const getPlayerMarket = async (teamId) => {
  const [listings, requests] = await Promise.all([
    query(
      `SELECT pl.id, pl.seller_team_id, seller.name AS seller_team_name,
         pl.player_id, COALESCE(p.display_name, p.name) AS player_name,
         p.photo AS player_photo, p.role, p.country, pl.asking_price,
         pl.created_at
       FROM player_listings pl
       JOIN college_teams seller ON seller.id = pl.seller_team_id
       JOIN players p ON p.id = pl.player_id
      WHERE pl.status = 'OPEN'
       ORDER BY pl.created_at, pl.id LIMIT 100`,
      [teamId],
    ),
    query(
      `SELECT pr.id, pr.listing_id, pr.buyer_team_id,
         buyer.name AS buyer_team_name, pl.seller_team_id,
         seller.name AS seller_team_name, pl.player_id,
         COALESCE(p.display_name, p.name) AS player_name,
         p.photo AS player_photo, pl.asking_price, pr.status,
         pr.buyer_acknowledged_at, pr.created_at, pr.updated_at
       FROM player_purchase_requests pr
       JOIN player_listings pl ON pl.id = pr.listing_id
       JOIN college_teams buyer ON buyer.id = pr.buyer_team_id
       JOIN college_teams seller ON seller.id = pl.seller_team_id
       JOIN players p ON p.id = pl.player_id
       WHERE pr.buyer_team_id = $1 OR pl.seller_team_id = $1
       ORDER BY pr.created_at, pr.id LIMIT 200`,
      [teamId],
    ),
  ]);
  return { listings: listings.rows, requests: requests.rows };
};

const requireTradeWindow = async (client) => {
  if (!(await tradeWindowValue(client))) {
    throw new Error("The trade window is closed");
  }
};

export const createPlayerListing = async ({ teamId, playerId, askingPrice }) =>
  withTransaction(async (client) => {
    await requireTradeWindow(client);
    const team = await client.query(
      `SELECT id, playing_xi_locked FROM college_teams
       WHERE id = $1 AND status = 'ACTIVE' FOR UPDATE`,
      [teamId],
    );
    if (!team.rowCount) throw new Error("Active team not found");
    if (team.rows[0].playing_xi_locked) {
      throw new Error("Listings are disabled after scores are finalized");
    }
    const owned = await client.query(
      "SELECT player_id FROM squads WHERE team_id = $1 AND player_id = $2 FOR UPDATE",
      [teamId, playerId],
    );
    if (!owned.rowCount) throw new Error("That player is not in your squad");
    const existing = await client.query(
      "SELECT id FROM player_listings WHERE player_id = $1 AND status = 'OPEN' FOR UPDATE",
      [playerId],
    );
    if (existing.rowCount) throw new Error("That player is already listed");

    const listing = await client.query(
      `INSERT INTO player_listings (seller_team_id, player_id, asking_price)
       VALUES ($1, $2, $3) RETURNING *`,
      [teamId, playerId, askingPrice],
    );
    await client.query(
      `INSERT INTO audit_logs (actor_team_id, action, target, new_value)
       VALUES ($1, 'PLAYER_LISTED_FOR_SALE', $2, $3::jsonb)`,
      [teamId, listing.rows[0].id, JSON.stringify({ playerId, askingPrice })],
    );
    return listing.rows[0];
  });

export const cancelPlayerListing = async ({ teamId, listingId }) =>
  withTransaction(async (client) => {
    await requireTradeWindow(client);
    const listing = await client.query(
      `UPDATE player_listings SET status = 'CANCELLED', updated_at = NOW()
       WHERE id = $1 AND seller_team_id = $2 AND status = 'OPEN'
       RETURNING *`,
      [listingId, teamId],
    );
    if (!listing.rowCount) throw new Error("Open listing not found");
    await client.query(
      `UPDATE player_purchase_requests SET status = 'CANCELLED',
         buyer_acknowledged_at = NULL, updated_at = NOW()
       WHERE listing_id = $1 AND status = 'PENDING'`,
      [listingId],
    );
    return listing.rows[0];
  });

export const requestPlayerPurchase = async ({ teamId, listingId }) =>
  withTransaction(async (client) => {
    await requireTradeWindow(client);
    const listing = await client.query(
      "SELECT * FROM player_listings WHERE id = $1 AND status = 'OPEN' FOR UPDATE",
      [listingId],
    );
    if (!listing.rowCount) throw new Error("This listing is no longer open");
    const sale = listing.rows[0];
    if (sale.seller_team_id === teamId) {
      throw new Error("You cannot request your own listing");
    }
    const teams = await client.query(
      `SELECT id, playing_xi_locked FROM college_teams
       WHERE id = ANY($1::uuid[]) AND status = 'ACTIVE'
       ORDER BY id FOR UPDATE`,
      [[teamId, sale.seller_team_id]],
    );
    if (teams.rowCount !== 2)
      throw new Error("One of these teams is not active");
    if (teams.rows.some((team) => team.playing_xi_locked)) {
      throw new Error("Purchases are disabled after scores are finalized");
    }
    const wallet = await client.query(
      "SELECT available_purse FROM wallets WHERE team_id = $1 FOR UPDATE",
      [teamId],
    );
    if (!wallet.rowCount) throw new Error("Buyer wallet not found");
    if (Number(wallet.rows[0].available_purse) < Number(sale.asking_price)) {
      throw new Error("Your available purse is below the asking price");
    }
    const squad = await client.query(
      "SELECT COUNT(*)::int AS count FROM squads WHERE team_id = $1",
      [teamId],
    );
    if (squad.rows[0].count >= 18) {
      throw new Error("Your squad cannot have more than 18 players");
    }
    const request = await client.query(
      `INSERT INTO player_purchase_requests (listing_id, buyer_team_id)
       VALUES ($1, $2) RETURNING *`,
      [listingId, teamId],
    );
    await client.query(
      `INSERT INTO audit_logs (actor_team_id, action, target, new_value)
       VALUES ($1, 'PLAYER_PURCHASE_REQUESTED', $2, $3::jsonb)`,
      [teamId, request.rows[0].id, JSON.stringify({ listingId })],
    );
    return { ...request.rows[0], seller_team_id: sale.seller_team_id };
  });

export const respondToPurchaseRequest = async ({ teamId, requestId, accept }) =>
  withTransaction(async (client) => {
    await requireTradeWindow(client);
    const requestRef = await client.query(
      "SELECT listing_id FROM player_purchase_requests WHERE id = $1",
      [requestId],
    );
    if (!requestRef.rowCount) throw new Error("Purchase request not found");
    const listingResult = await client.query(
      "SELECT * FROM player_listings WHERE id = $1 FOR UPDATE",
      [requestRef.rows[0].listing_id],
    );
    if (!listingResult.rowCount) throw new Error("Listing no longer exists");
    const requestResult = await client.query(
      "SELECT * FROM player_purchase_requests WHERE id = $1 FOR UPDATE",
      [requestId],
    );
    if (!requestResult.rowCount) throw new Error("Purchase request not found");
    const purchaseRequest = requestResult.rows[0];
    const listing = listingResult.rows[0];
    if (listing.seller_team_id !== teamId) {
      throw new Error("Only the seller can respond to this request");
    }
    if (purchaseRequest.status !== "PENDING" || listing.status !== "OPEN") {
      throw new Error("This request is no longer pending");
    }

    if (accept) {
      const teams = await client.query(
        `SELECT id, playing_xi_locked FROM college_teams
         WHERE id = ANY($1::uuid[]) AND status = 'ACTIVE'
         ORDER BY id FOR UPDATE`,
        [[listing.seller_team_id, purchaseRequest.buyer_team_id]],
      );
      if (teams.rowCount !== 2)
        throw new Error("One of these teams is not active");
      if (teams.rows.some((team) => team.playing_xi_locked)) {
        throw new Error("Trades are disabled after scores are finalized");
      }
      const wallets = await client.query(
        `SELECT team_id, available_purse FROM wallets
         WHERE team_id = ANY($1::uuid[]) ORDER BY team_id FOR UPDATE`,
        [[listing.seller_team_id, purchaseRequest.buyer_team_id]],
      );
      if (wallets.rowCount !== 2)
        throw new Error("One of these wallets is missing");
      const buyerWallet = wallets.rows.find(
        (wallet) => wallet.team_id === purchaseRequest.buyer_team_id,
      );
      if (Number(buyerWallet.available_purse) < Number(listing.asking_price)) {
        throw new Error("Buyer no longer has enough available purse");
      }

      const counts = await client.query(
        `SELECT team_id, COUNT(*)::int AS count FROM squads
         WHERE team_id = ANY($1::uuid[]) GROUP BY team_id`,
        [[listing.seller_team_id, purchaseRequest.buyer_team_id]],
      );
      const countByTeam = new Map(
        counts.rows.map((row) => [row.team_id, row.count]),
      );
      if ((countByTeam.get(listing.seller_team_id) || 0) <= 11) {
        throw new Error("Seller must keep at least 11 squad players");
      }
      if ((countByTeam.get(purchaseRequest.buyer_team_id) || 0) >= 18) {
        throw new Error("Buyer cannot have more than 18 squad players");
      }

      const player = await client.query(
        `SELECT id FROM squads WHERE player_id = $1 AND team_id = $2 FOR UPDATE`,
        [listing.player_id, listing.seller_team_id],
      );
      if (!player.rowCount)
        throw new Error("Seller no longer owns this player");

      await client.query(
        `UPDATE wallets SET available_purse = available_purse - $2,
           spent_purse = spent_purse + $2, updated_at = NOW()
         WHERE team_id = $1`,
        [purchaseRequest.buyer_team_id, listing.asking_price],
      );
      await client.query(
        "UPDATE college_teams SET spent = spent + $2, updated_at = NOW() WHERE id = $1",
        [purchaseRequest.buyer_team_id, listing.asking_price],
      );
      await client.query(
        `UPDATE wallets SET available_purse = available_purse + $2,
           updated_at = NOW() WHERE team_id = $1`,
        [listing.seller_team_id, listing.asking_price],
      );
      await client.query(
        `UPDATE squads SET team_id = $1, is_playing_xi = FALSE
         WHERE team_id = $2 AND player_id = $3`,
        [
          purchaseRequest.buyer_team_id,
          listing.seller_team_id,
          listing.player_id,
        ],
      );
      await client.query(
        `UPDATE squads SET is_playing_xi = FALSE
         WHERE team_id = ANY($1::uuid[])`,
        [[listing.seller_team_id, purchaseRequest.buyer_team_id]],
      );
      await client.query(
        "UPDATE player_listings SET status = 'SOLD', updated_at = NOW() WHERE id = $1",
        [listing.id],
      );
      await client.query(
        `UPDATE trade_offers SET status = 'CANCELLED',
           buyer_acknowledged_at = NULL, updated_at = NOW()
         WHERE status = 'PENDING'
           AND (offered_player_id = $1 OR requested_player_id = $1)`,
        [listing.player_id],
      );
      await client.query(
        `UPDATE player_purchase_requests SET status = 'DECLINED',
           buyer_acknowledged_at = NULL, updated_at = NOW()
         WHERE listing_id = $1 AND id <> $2 AND status = 'PENDING'`,
        [listing.id, requestId],
      );
    }

    const status = accept ? "ACCEPTED" : "DECLINED";
    const updated = await client.query(
      `UPDATE player_purchase_requests SET status = $2,
         buyer_acknowledged_at = NULL, updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [requestId, status],
    );
    await client.query(
      `INSERT INTO audit_logs (actor_team_id, action, target, new_value)
       VALUES ($1, 'PLAYER_PURCHASE_RESPONDED', $2, $3::jsonb)`,
      [teamId, requestId, JSON.stringify({ status })],
    );
    return {
      ...updated.rows[0],
      seller_team_id: listing.seller_team_id,
    };
  });

export const acknowledgeTradeNotification = async ({ teamId, type, id }) => {
  const table =
    type === "purchase" ? "player_purchase_requests" : "trade_offers";
  const buyerColumn = type === "purchase" ? "buyer_team_id" : "from_team_id";
  const result = await query(
    `UPDATE ${table} SET buyer_acknowledged_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND ${buyerColumn} = $2
       AND buyer_acknowledged_at IS NULL RETURNING id`,
    [id, teamId],
  );
  if (!result.rowCount) throw new Error("Trade notification not found");
  return { acknowledged: true };
};

export const cancelPurchaseRequest = async ({ teamId, requestId }) => {
  const result = await query(
    `UPDATE player_purchase_requests SET status = 'CANCELLED',
       buyer_acknowledged_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND buyer_team_id = $2 AND status = 'PENDING'
     RETURNING *`,
    [requestId, teamId],
  );
  if (!result.rowCount) throw new Error("Pending purchase request not found");
  return result.rows[0];
};

export const createTradeOffer = async ({
  fromTeamId,
  toTeamId,
  offeredPlayerId,
  requestedPlayerId,
  cashAmount = 0,
}) =>
  withTransaction(async (client) => {
    await requireTradeWindow(client);
    if (fromTeamId === toTeamId) {
      throw new Error("Choose a different team for this trade");
    }

    const teams = await client.query(
      `SELECT id, playing_xi_locked FROM college_teams
       WHERE id = ANY($1::uuid[]) AND status = 'ACTIVE'
       ORDER BY id FOR UPDATE`,
      [[fromTeamId, toTeamId]],
    );
    if (teams.rowCount !== 2)
      throw new Error("One of these teams is not active");
    if (teams.rows.some((team) => team.playing_xi_locked)) {
      throw new Error("Trades are disabled after scores are finalized");
    }

    const ownedPlayers = await client.query(
      `SELECT team_id, player_id FROM squads
       WHERE (team_id = $1 AND player_id = $3)
          OR (team_id = $2 AND player_id = $4)
       FOR UPDATE`,
      [fromTeamId, toTeamId, offeredPlayerId, requestedPlayerId],
    );
    if (ownedPlayers.rowCount !== 2) {
      throw new Error("Both players must belong to the teams in the offer");
    }

    if (cashAmount > 0) {
      const wallet = await client.query(
        "SELECT available_purse FROM wallets WHERE team_id = $1 FOR UPDATE",
        [fromTeamId],
      );
      if (!wallet.rowCount) throw new Error("Offering team wallet not found");
      if (Number(wallet.rows[0].available_purse) < cashAmount) {
        throw new Error("Your available purse cannot cover the cash offer");
      }
    }

    const offer = await client.query(
      `INSERT INTO trade_offers
        (from_team_id, to_team_id, offered_player_id, requested_player_id,
         cash_amount, buyer_acknowledged_at)
       VALUES ($1, $2, $3, $4, $5, NULL) RETURNING *`,
      [fromTeamId, toTeamId, offeredPlayerId, requestedPlayerId, cashAmount],
    );
    await client.query(
      `INSERT INTO audit_logs (actor_team_id, action, target, new_value)
       VALUES ($1, 'TRADE_OFFER_CREATED', $2, $3::jsonb)`,
      [
        fromTeamId,
        offer.rows[0].id,
        JSON.stringify({
          toTeamId,
          offeredPlayerId,
          requestedPlayerId,
          cashAmount,
        }),
      ],
    );
    return offer.rows[0];
  });

export const respondToTradeOffer = async ({ teamId, offerId, accept }) =>
  withTransaction(async (client) => {
    if (!(await tradeWindowValue(client))) {
      throw new Error("The trade window is closed");
    }

    const offerResult = await client.query(
      "SELECT * FROM trade_offers WHERE id = $1 FOR UPDATE",
      [offerId],
    );
    if (offerResult.rowCount === 0) throw new Error("Trade offer not found");
    const offer = offerResult.rows[0];
    if (offer.to_team_id !== teamId) {
      throw new Error("Only the receiving team can respond to this offer");
    }
    if (offer.status !== "PENDING") {
      throw new Error("This trade offer is no longer pending");
    }

    const status = accept ? "ACCEPTED" : "DECLINED";
    if (accept) {
      const teams = await client.query(
        `SELECT id, playing_xi_locked FROM college_teams WHERE id = ANY($1::uuid[])
         AND status = 'ACTIVE' ORDER BY id FOR UPDATE`,
        [[offer.from_team_id, offer.to_team_id]],
      );
      if (teams.rowCount !== 2)
        throw new Error("One of these teams is not active");
      if (teams.rows.some((team) => team.playing_xi_locked)) {
        throw new Error("Trades are disabled after scores are finalized");
      }
      const players = await client.query(
        `SELECT team_id, player_id FROM squads
         WHERE (team_id = $1 AND player_id = $3)
            OR (team_id = $2 AND player_id = $4)
         FOR UPDATE`,
        [
          offer.from_team_id,
          offer.to_team_id,
          offer.offered_player_id,
          offer.requested_player_id,
        ],
      );
      if (players.rowCount !== 2) {
        throw new Error("A player in this offer is no longer on that team");
      }

      if (Number(offer.cash_amount) > 0) {
        const wallets = await client.query(
          `SELECT team_id, available_purse FROM wallets
           WHERE team_id = ANY($1::uuid[]) ORDER BY team_id FOR UPDATE`,
          [[offer.from_team_id, offer.to_team_id]],
        );
        if (wallets.rowCount !== 2)
          throw new Error("One of these wallets is missing");
        const buyerWallet = wallets.rows.find(
          (wallet) => wallet.team_id === offer.from_team_id,
        );
        if (Number(buyerWallet.available_purse) < Number(offer.cash_amount)) {
          throw new Error("Offering team no longer has enough available purse");
        }
        await client.query(
          `UPDATE wallets SET available_purse = available_purse - $2,
             spent_purse = spent_purse + $2, updated_at = NOW() WHERE team_id = $1`,
          [offer.from_team_id, offer.cash_amount],
        );
        await client.query(
          "UPDATE college_teams SET spent = spent + $2, updated_at = NOW() WHERE id = $1",
          [offer.from_team_id, offer.cash_amount],
        );
        await client.query(
          `UPDATE wallets SET available_purse = available_purse + $2,
             updated_at = NOW() WHERE team_id = $1`,
          [offer.to_team_id, offer.cash_amount],
        );
      }

      await client.query(
        `UPDATE squads SET team_id = $1
         WHERE team_id = $2 AND player_id = $3`,
        [offer.to_team_id, offer.from_team_id, offer.offered_player_id],
      );
      await client.query(
        `UPDATE squads SET team_id = $1
         WHERE team_id = $2 AND player_id = $3`,
        [offer.from_team_id, offer.to_team_id, offer.requested_player_id],
      );
      const closedListings = await client.query(
        `UPDATE player_listings SET status = 'CANCELLED', updated_at = NOW()
         WHERE status = 'OPEN' AND player_id = ANY($1::uuid[])
         RETURNING id`,
        [[offer.offered_player_id, offer.requested_player_id]],
      );
      if (closedListings.rowCount > 0) {
        await client.query(
          `UPDATE player_purchase_requests SET status = 'CANCELLED',
             buyer_acknowledged_at = NULL, updated_at = NOW()
           WHERE listing_id = ANY($1::uuid[]) AND status = 'PENDING'`,
          [closedListings.rows.map((listing) => listing.id)],
        );
      }
      await client.query(
        `UPDATE trade_offers SET status = 'CANCELLED',
           buyer_acknowledged_at = NULL, updated_at = NOW()
         WHERE id <> $1 AND status = 'PENDING'
           AND (offered_player_id = ANY($2::uuid[])
             OR requested_player_id = ANY($2::uuid[]))`,
        [offer.id, [offer.offered_player_id, offer.requested_player_id]],
      );
    }

    await client.query(
      `UPDATE trade_offers SET status = $2, buyer_acknowledged_at = NULL,
        updated_at = NOW() WHERE id = $1`,
      [offer.id, status],
    );
    await client.query(
      `INSERT INTO audit_logs (actor_team_id, action, target, new_value)
       VALUES ($1, 'TRADE_OFFER_RESPONDED', $2, $3::jsonb)`,
      [
        teamId,
        offer.id,
        JSON.stringify({ status, cashAmount: Number(offer.cash_amount || 0) }),
      ],
    );
    return { ...offer, status };
  });

export const cancelTradeOffer = async ({ teamId, offerId }) =>
  withTransaction(async (client) => {
    const result = await client.query(
      `UPDATE trade_offers SET status = 'CANCELLED', buyer_acknowledged_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND from_team_id = $2 AND status = 'PENDING'
       RETURNING *`,
      [offerId, teamId],
    );
    if (result.rowCount === 0) {
      throw new Error("Pending trade offer not found for your team");
    }
    return result.rows[0];
  });
