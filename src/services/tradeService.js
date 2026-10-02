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

export const createTradeOffer = async ({
  fromTeamId,
  toTeamId,
  offeredPlayerId,
  requestedPlayerId,
}) =>
  withTransaction(async (client) => {
    if (!(await tradeWindowValue(client))) {
      throw new Error("The trade window is closed");
    }
    if (fromTeamId === toTeamId) {
      throw new Error("Choose a different team for this trade");
    }

    const teams = await client.query(
      `SELECT id FROM college_teams
       WHERE id = ANY($1::uuid[]) AND status = 'ACTIVE'
       ORDER BY id FOR UPDATE`,
      [[fromTeamId, toTeamId]],
    );
    if (teams.rowCount !== 2)
      throw new Error("One of these teams is not active");

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

    const offer = await client.query(
      `INSERT INTO trade_offers
         (from_team_id, to_team_id, offered_player_id, requested_player_id)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [fromTeamId, toTeamId, offeredPlayerId, requestedPlayerId],
    );
    await client.query(
      `INSERT INTO audit_logs (actor_team_id, action, target, new_value)
       VALUES ($1, 'TRADE_OFFER_CREATED', $2, $3::jsonb)`,
      [
        fromTeamId,
        offer.rows[0].id,
        JSON.stringify({ toTeamId, offeredPlayerId, requestedPlayerId }),
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
      await client.query(
        `SELECT id, playing_xi_locked FROM college_teams WHERE id = ANY($1::uuid[])
         ORDER BY id FOR UPDATE`,
        [[offer.from_team_id, offer.to_team_id]],
      );
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
    }

    await client.query(
      "UPDATE trade_offers SET status = $2, updated_at = NOW() WHERE id = $1",
      [offer.id, status],
    );
    await client.query(
      `INSERT INTO audit_logs (actor_team_id, action, target, new_value)
       VALUES ($1, 'TRADE_OFFER_RESPONDED', $2, $3::jsonb)`,
      [teamId, offer.id, JSON.stringify({ status })],
    );
    return { ...offer, status };
  });

export const cancelTradeOffer = async ({ teamId, offerId }) =>
  withTransaction(async (client) => {
    const result = await client.query(
      `UPDATE trade_offers SET status = 'CANCELLED', updated_at = NOW()
       WHERE id = $1 AND from_team_id = $2 AND status = 'PENDING'
       RETURNING *`,
      [offerId, teamId],
    );
    if (result.rowCount === 0) {
      throw new Error("Pending trade offer not found for your team");
    }
    return result.rows[0];
  });
