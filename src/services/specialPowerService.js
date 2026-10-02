import { query, withTransaction } from "../database/connection.js";

const POWER_SUPER_STEAL = "SUPER_STEAL";
const POWER_TACTICAL_TIMEOUT = "TACTICAL_TIMEOUT";

export const getTeamPowerState = async (teamId) => {
  const auctionResult = await query(
    "SELECT id, status, current_player_id, current_bid, highest_bidder_team_id, bid_ends_at FROM auction ORDER BY created_at DESC LIMIT 1",
  );
  const teamResult = await query(
    `SELECT ct.purse, w.available_purse, w.spent_purse
     FROM college_teams ct JOIN wallets w ON w.team_id = ct.id
     WHERE ct.id = $1`,
    [teamId],
  );
  if (teamResult.rowCount === 0) throw new Error("Team wallet not found");

  const auction = auctionResult.rows[0] || null;
  const usedResult = auction
    ? await query(
        `SELECT power_key FROM team_power_uses
         WHERE auction_id = $1 AND team_id = $2`,
        [auction.id, teamId],
      )
    : { rows: [] };
  const used = new Set(usedResult.rows.map((row) => row.power_key));
  const team = teamResult.rows[0];
  const live =
    auction?.status === "BIDDING" &&
    auction.bid_ends_at &&
    new Date(auction.bid_ends_at) > new Date();
  const currentBid = Number(auction?.current_bid || 0);
  const threshold = Number(team.purse) * 0.5;
  const availablePurse = Number(team.available_purse || 0);

  return {
    auctionId: auction?.id || null,
    threshold,
    availablePurse,
    superStealUsed: used.has(POWER_SUPER_STEAL),
    tacticalTimeoutUsed: used.has(POWER_TACTICAL_TIMEOUT),
    canSuperSteal:
      Boolean(live) &&
      currentBid >= threshold &&
      auction.highest_bidder_team_id !== teamId &&
      currentBid <= availablePurse &&
      !used.has(POWER_SUPER_STEAL),
    canUseTacticalTimeout: Boolean(live) && !used.has(POWER_TACTICAL_TIMEOUT),
  };
};

export const useSuperSteal = async ({ teamId, actorId, playerId }) =>
  withTransaction(async (client) => {
    const auctionResult = await client.query(
      "SELECT * FROM auction ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
    );
    if (auctionResult.rowCount === 0)
      throw new Error("Auction not initialized");
    const auction = auctionResult.rows[0];
    if (
      auction.status !== "BIDDING" ||
      auction.current_player_id !== playerId ||
      !auction.bid_ends_at ||
      new Date(auction.bid_ends_at) <= new Date()
    ) {
      throw new Error("Super Steal is only available during live bidding");
    }
    if (auction.highest_bidder_team_id === teamId) {
      throw new Error("Your team is already leading this player");
    }

    const teamResult = await client.query(
      "SELECT * FROM college_teams WHERE id = $1 AND status = 'ACTIVE' FOR UPDATE",
      [teamId],
    );
    if (teamResult.rowCount === 0) throw new Error("Team is not active");
    const team = teamResult.rows[0];
    const squadCount = await client.query(
      "SELECT COUNT(*)::int AS count FROM squads WHERE team_id = $1",
      [teamId],
    );
    if (squadCount.rows[0].count >= 18) {
      throw new Error("A team cannot have more than 18 players");
    }
    const currentBid = Number(auction.current_bid);
    if (currentBid < Number(team.purse) * 0.5) {
      throw new Error(
        "Super Steal unlocks when the bid reaches half your purse",
      );
    }

    const walletResult = await client.query(
      "SELECT * FROM wallets WHERE team_id = $1 FOR UPDATE",
      [teamId],
    );
    if (walletResult.rowCount === 0) throw new Error("Wallet not found");
    const wallet = walletResult.rows[0];
    if (currentBid > Number(wallet.available_purse)) {
      throw new Error("Your remaining purse cannot cover this steal");
    }

    const playerResult = await client.query(
      "SELECT * FROM players WHERE id = $1 FOR UPDATE",
      [playerId],
    );
    if (
      playerResult.rowCount === 0 ||
      playerResult.rows[0].status !== "AVAILABLE"
    ) {
      throw new Error("Player is no longer available");
    }

    await client.query(
      `INSERT INTO team_power_uses (auction_id, team_id, power_key, player_id)
       VALUES ($1, $2, $3, $4)`,
      [auction.id, teamId, POWER_SUPER_STEAL, playerId],
    );
    await client.query(
      `INSERT INTO bids (auction_id, player_id, team_id, amount, sequence_number)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        auction.id,
        playerId,
        teamId,
        currentBid,
        Number(auction.current_sequence || 0) + 1,
      ],
    );
    await client.query(
      "INSERT INTO squads (team_id, player_id, acquired_price) VALUES ($1, $2, $3)",
      [teamId, playerId, currentBid],
    );
    await client.query(
      `UPDATE wallets SET available_purse = available_purse - $2,
       spent_purse = spent_purse + $2, updated_at = NOW() WHERE team_id = $1`,
      [teamId, currentBid],
    );
    await client.query(
      "UPDATE college_teams SET spent = spent + $2, updated_at = NOW() WHERE id = $1",
      [teamId, currentBid],
    );
    await client.query(
      "UPDATE players SET status = 'SOLD', updated_at = NOW() WHERE id = $1",
      [playerId],
    );
    await client.query(
      `UPDATE auction_players SET status = 'SOLD', sold_team_id = $3, sold_price = $4
       WHERE auction_id = $1 AND player_id = $2 AND status = 'CURRENT'`,
      [auction.id, playerId, teamId, currentBid],
    );
    const soldResult = await client.query(
      `UPDATE auction SET status = 'PLAYER_SOLD', highest_bidder_team_id = $1,
       current_sequence = current_sequence + 1, bid_ends_at = NULL, updated_at = NOW()
       WHERE id = $2 RETURNING *`,
      [teamId, auction.id],
    );
    await client.query(
      `INSERT INTO audit_logs (actor_user_id, actor_team_id, action, target, new_value)
       VALUES ($1, $2, 'POWER_SUPER_STEAL', $3, $4::jsonb)`,
      [
        actorId,
        teamId,
        playerId,
        JSON.stringify({
          amount: currentBid,
          priorBidderTeamId: auction.highest_bidder_team_id,
        }),
      ],
    );

    return {
      auction: soldResult.rows[0],
      teamId,
      teamName: team.name,
      playerId,
      amount: currentBid,
    };
  });

export const useTacticalTimeout = async ({ teamId, actorId }) =>
  withTransaction(async (client) => {
    const auctionResult = await client.query(
      "SELECT * FROM auction ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
    );
    if (auctionResult.rowCount === 0)
      throw new Error("Auction not initialized");
    const auction = auctionResult.rows[0];
    if (
      auction.status !== "BIDDING" ||
      !auction.bid_ends_at ||
      new Date(auction.bid_ends_at) <= new Date()
    ) {
      throw new Error("Tactical Timeout is only available during live bidding");
    }

    const teamResult = await client.query(
      "SELECT id, name FROM college_teams WHERE id = $1 AND status = 'ACTIVE' FOR UPDATE",
      [teamId],
    );
    if (teamResult.rowCount === 0) throw new Error("Team is not active");

    await client.query(
      `INSERT INTO team_power_uses (auction_id, team_id, power_key)
       VALUES ($1, $2, $3)`,
      [auction.id, teamId, POWER_TACTICAL_TIMEOUT],
    );
    const updated = await client.query(
      `UPDATE auction SET bid_ends_at = GREATEST(bid_ends_at, NOW()) + INTERVAL '10 seconds',
       updated_at = NOW() WHERE id = $1 RETURNING *`,
      [auction.id],
    );
    await client.query(
      `INSERT INTO audit_logs (actor_user_id, actor_team_id, action, target, new_value)
       VALUES ($1, $2, 'POWER_TACTICAL_TIMEOUT', $3, $4::jsonb)`,
      [
        actorId,
        teamId,
        auction.current_player_id,
        JSON.stringify({ secondsAdded: 10 }),
      ],
    );

    return {
      auction: updated.rows[0],
      teamId,
      teamName: teamResult.rows[0].name,
    };
  });
