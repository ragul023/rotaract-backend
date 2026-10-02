import { query, withTransaction } from "../database/connection.js";

const POWER_SUPER_STEAL = "SUPER_STEAL";
const SUPER_STEAL_LIMIT = 3;

export const getTeamPowerState = async (teamId) => {
  const [auctionResult, teamResult] = await Promise.all([
    query(
      "SELECT id, status, current_player_id, current_bid, highest_bidder_team_id FROM auction ORDER BY created_at DESC LIMIT 1",
    ),
    query(
      `SELECT ct.purse, w.available_purse, w.spent_purse
       FROM college_teams ct JOIN wallets w ON w.team_id = ct.id
       WHERE ct.id = $1`,
      [teamId],
    ),
  ]);
  if (teamResult.rowCount === 0) throw new Error("Team wallet not found");

  const auction = auctionResult.rows[0] || null;
  const usageResult = auction
    ? await query(
        `SELECT COUNT(*)::int AS uses FROM team_power_uses
         WHERE auction_id = $1 AND team_id = $2 AND power_key = $3`,
        [auction.id, teamId, POWER_SUPER_STEAL],
      )
    : { rows: [{ uses: 0 }] };
  const superStealUses = usageResult.rows[0]?.uses || 0;
  const superStealRemaining = Math.max(0, SUPER_STEAL_LIMIT - superStealUses);
  const team = teamResult.rows[0];
  const live =
    auction?.status === "BIDDING" && Boolean(auction.current_player_id);
  const currentBid = Number(auction?.current_bid || 0);
  const threshold = Number(team.purse) * 0.5;
  const availablePurse = Number(team.available_purse || 0);

  return {
    auctionId: auction?.id || null,
    threshold,
    availablePurse,
    superStealUses,
    superStealLimit: SUPER_STEAL_LIMIT,
    superStealRemaining,
    superStealUsed: superStealRemaining === 0,
    canSuperSteal:
      Boolean(live) &&
      currentBid >= threshold &&
      auction.highest_bidder_team_id !== teamId &&
      currentBid <= availablePurse &&
      superStealRemaining > 0,
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
      auction.current_player_id !== playerId
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
    const usageResult = await client.query(
      `SELECT COUNT(*)::int AS uses FROM team_power_uses
       WHERE auction_id = $1 AND team_id = $2 AND power_key = $3`,
      [auction.id, teamId, POWER_SUPER_STEAL],
    );
    const superStealUses = usageResult.rows[0].uses;
    if (superStealUses >= SUPER_STEAL_LIMIT) {
      throw new Error("Your team has used all 3 Super Steals this auction");
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
       current_sequence = current_sequence + 1, updated_at = NOW()
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
      superStealUses: superStealUses + 1,
      superStealRemaining: SUPER_STEAL_LIMIT - superStealUses - 1,
    };
  });
