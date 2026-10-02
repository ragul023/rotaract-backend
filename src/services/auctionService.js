import { query, withTransaction } from "../database/connection.js";

const readDefaultBidTime = async (client) => {
  const result = await client.query(
    "SELECT value FROM game_settings WHERE key = 'initial_timer_seconds'",
  );
  const seconds = Number(result.rows[0]?.value ?? 30);
  return Number.isInteger(seconds) && seconds >= 5 && seconds <= 600
    ? seconds
    : 30;
};

export const getDefaultBidTime = async () => readDefaultBidTime({ query });

export const updateDefaultBidTime = async ({ actorId, seconds }) =>
  withTransaction(async (client) => {
    await client.query(
      `INSERT INTO game_settings (key, value)
       VALUES ('initial_timer_seconds', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [JSON.stringify(seconds)],
    );
    const active = await client.query(
      "SELECT id FROM auction ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
    );
    if (active.rowCount > 0) {
      await client.query(
        "UPDATE auction SET timer_seconds = $2, updated_at = NOW() WHERE id = $1",
        [active.rows[0].id, seconds],
      );
    }
    await client.query(
      `INSERT INTO audit_logs (actor_user_id, action, target, new_value)
       VALUES ($1, 'BID_TIME_UPDATED', NULL, $2::jsonb)`,
      [actorId, JSON.stringify({ seconds })],
    );
    return { seconds };
  });

export const getAuctionState = async () => {
  const auction = await query(
    `SELECT a.*, p.name AS player_name, p.display_name AS player_display_name,
       p.photo AS player_photo, p.country AS player_country, p.role AS player_role,
       p.base_price AS player_base_price, f.name AS franchise_name,
       t.name AS highest_bidder_team_name
     FROM auction a
     LEFT JOIN players p ON p.id = a.current_player_id
     LEFT JOIN ipl_franchises f ON f.id = p.franchise_id
     LEFT JOIN college_teams t ON t.id = a.highest_bidder_team_id
     ORDER BY a.created_at DESC LIMIT 1`,
  );
  if (auction.rowCount === 0) {
    return null;
  }
  return auction.rows[0];
};

export const getPlayerQueue = async () => {
  const auctionResult = await query(
    "SELECT id, status, current_player_id FROM auction ORDER BY created_at DESC LIMIT 1",
  );
  const auction = auctionResult.rows[0] || null;
  const canEdit =
    !auction ||
    [
      "LOBBY",
      "BIDDING",
      "AUCTION_PAUSED",
      "PLAYER_SOLD",
      "PLAYER_UNSOLD",
      "AUCTION_COMPLETED",
      "FINISHED",
    ].includes(auction.status);
  const usePreview =
    !auction || ["AUCTION_COMPLETED", "FINISHED"].includes(auction.status);

  let queue = [];
  if (auction && !usePreview) {
    const queued = await query(
      `SELECT ap.player_id, ap.order_index, ap.status AS queue_status,
         p.name, p.display_name, p.photo, p.country, p.role, p.base_price,
         f.name AS franchise_name
       FROM auction_players ap
       JOIN players p ON p.id = ap.player_id
       LEFT JOIN ipl_franchises f ON f.id = p.franchise_id
       WHERE ap.auction_id = $1 AND ap.status = 'PENDING'
       ORDER BY ap.order_index, p.name`,
      [auction.id],
    );
    queue = queued.rows;
  }

  if (
    usePreview ||
    !auction ||
    (auction.status === "LOBBY" && queue.length === 0)
  ) {
    const available = await query(
      `SELECT p.id AS player_id, p.name, p.display_name, p.photo, p.country,
         p.role, p.base_price, f.name AS franchise_name
       FROM players p
       LEFT JOIN ipl_franchises f ON f.id = p.franchise_id
       WHERE p.status = 'AVAILABLE'
       ORDER BY p.created_at, p.id`,
    );
    queue = available.rows.map((player, index) => ({
      ...player,
      order_index: index + 1,
      queue_status: "PENDING",
    }));
  }

  const queuedIds = queue.map((player) => player.player_id);
  const availablePlayers = await query(
    `SELECT p.id AS player_id, p.name, p.display_name, p.photo, p.country,
       p.role, p.base_price, f.name AS franchise_name
     FROM players p
     LEFT JOIN ipl_franchises f ON f.id = p.franchise_id
     WHERE p.status = 'AVAILABLE'
         AND ($2::uuid IS NULL OR p.id <> $2)
       AND NOT (p.id = ANY($1::uuid[]))
     ORDER BY p.name`,
    [
      queuedIds,
      ["BIDDING", "AUCTION_PAUSED"].includes(auction?.status)
        ? auction.current_player_id
        : null,
    ],
  );

  return {
    auctionId: auction?.id || null,
    auctionStatus: auction?.status || "LOBBY",
    editable: canEdit,
    queue,
    availablePlayers: availablePlayers.rows,
  };
};

export const updatePlayerQueue = async ({ actorId, playerIds }) => {
  await withTransaction(async (client) => {
    const active = await client.query(
      "SELECT * FROM auction ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
    );
    let auction = active.rows[0];

    if (
      !auction ||
      ["AUCTION_COMPLETED", "FINISHED"].includes(auction.status)
    ) {
      const timerSeconds = await readDefaultBidTime(client);
      const created = await client.query(
        `INSERT INTO auction (status, current_bid, bid_increment, timer_seconds)
         VALUES ('LOBBY', 0, 1, $1) RETURNING *`,
        [timerSeconds],
      );
      auction = created.rows[0];
    } else if (
      ![
        "LOBBY",
        "BIDDING",
        "AUCTION_PAUSED",
        "PLAYER_SOLD",
        "PLAYER_UNSOLD",
      ].includes(auction.status)
    ) {
      throw new Error(
        "The player queue cannot be edited in the current auction state",
      );
    }

    const players = await client.query(
      `SELECT p.id FROM players p
       WHERE p.id = ANY($1::uuid[]) AND p.status = 'AVAILABLE'
         AND NOT EXISTS (
           SELECT 1 FROM auction_players ap
           WHERE ap.auction_id = $2 AND ap.player_id = p.id
             AND ap.status <> 'PENDING'
         )`,
      [playerIds, auction.id],
    );
    if (players.rowCount !== playerIds.length) {
      throw new Error("Queue contains a player who is no longer available");
    }

    await client.query(
      "DELETE FROM auction_players WHERE auction_id = $1 AND status = 'PENDING'",
      [auction.id],
    );

    for (const [index, playerId] of playerIds.entries()) {
      await client.query(
        `INSERT INTO auction_players (auction_id, player_id, order_index, status)
         VALUES ($1, $2, $3, 'PENDING')
         ON CONFLICT (auction_id, player_id) DO UPDATE SET
           order_index = EXCLUDED.order_index, status = 'PENDING',
           sold_team_id = NULL, sold_price = NULL`,
        [auction.id, playerId, index + 1],
      );
    }

    await client.query(
      `INSERT INTO audit_logs (actor_user_id, action, target, new_value)
       VALUES ($1, 'AUCTION_QUEUE_UPDATED', $2, $3::jsonb)`,
      [actorId, auction.id, JSON.stringify({ playerIds })],
    );

    return auction.id;
  });

  return getPlayerQueue();
};

export const startAuction = async () => {
  return withTransaction(async (client) => {
    const active = await client.query(
      "SELECT * FROM auction ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
    );
    let auction = active.rows[0];

    if (
      !auction ||
      ["AUCTION_COMPLETED", "FINISHED"].includes(auction.status)
    ) {
      const timerSeconds = await readDefaultBidTime(client);
      const inserted = await client.query(
        `INSERT INTO auction (status, current_bid, bid_increment, timer_seconds)
         VALUES ('LOBBY', 0, 1, $1) RETURNING *`,
        [timerSeconds],
      );
      auction = inserted.rows[0];
    } else if (auction.status !== "LOBBY") {
      throw new Error("Auction is already in progress or paused");
    }

    const queue = await client.query(
      "SELECT COUNT(*)::int AS count FROM auction_players WHERE auction_id = $1",
      [auction.id],
    );
    if (queue.rows[0].count === 0) {
      await client.query(
        `INSERT INTO auction_players (auction_id, player_id, order_index)
         SELECT $1, p.id, ROW_NUMBER() OVER (ORDER BY p.created_at, p.id)::int
         FROM players p
         WHERE p.status = 'AVAILABLE'
         ORDER BY p.created_at, p.id`,
        [auction.id],
      );
    }

    const next = await client.query(
      `SELECT ap.player_id, p.base_price
       FROM auction_players ap
       JOIN players p ON p.id = ap.player_id
       WHERE ap.auction_id = $1 AND ap.status = 'PENDING'
       ORDER BY ap.order_index
       LIMIT 1 FOR UPDATE OF ap`,
      [auction.id],
    );
    if (next.rowCount === 0) throw new Error("No available players to auction");

    await client.query(
      `UPDATE auction_players SET status = 'CURRENT'
       WHERE auction_id = $1 AND player_id = $2`,
      [auction.id, next.rows[0].player_id],
    );
    const started = await client.query(
      `UPDATE auction
       SET status = 'BIDDING', current_player_id = $2, current_bid = 0,
           highest_bidder_team_id = NULL, current_sequence = 0,
           bid_ends_at = NOW() + make_interval(secs => timer_seconds),
           auction_started_at = COALESCE(auction_started_at, NOW()), updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [auction.id, next.rows[0].player_id],
    );
    return started.rows[0];
  });
};

export const pauseAuction = async () => {
  return withTransaction(async (client) => {
    const active = await client.query(
      "SELECT * FROM auction ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
    );
    if (active.rowCount === 0 || active.rows[0].status !== "BIDDING") {
      throw new Error("Auction is not currently accepting bids");
    }
    const paused = await client.query(
      `UPDATE auction SET status = 'AUCTION_PAUSED', bid_ends_at = NULL,
       updated_at = NOW() WHERE id = $1 RETURNING *`,
      [active.rows[0].id],
    );
    return paused.rows[0];
  });
};

export const resumeAuction = async () => {
  return withTransaction(async (client) => {
    const active = await client.query(
      "SELECT * FROM auction ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
    );
    if (
      active.rowCount === 0 ||
      active.rows[0].status !== "AUCTION_PAUSED" ||
      !active.rows[0].current_player_id
    ) {
      throw new Error("There is no paused player to resume");
    }
    const resumed = await client.query(
      `UPDATE auction SET status = 'BIDDING',
       bid_ends_at = NOW() + make_interval(secs => timer_seconds),
       updated_at = NOW() WHERE id = $1 RETURNING *`,
      [active.rows[0].id],
    );
    return resumed.rows[0];
  });
};

export const nextPlayer = async () => {
  return withTransaction(async (client) => {
    const active = await client.query(
      "SELECT * FROM auction ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
    );
    if (active.rowCount === 0) throw new Error("Auction not initialized");
    const auction = active.rows[0];
    if (!["PLAYER_SOLD", "PLAYER_UNSOLD"].includes(auction.status)) {
      throw new Error("Current player must be sold or marked unsold first");
    }

    await client.query(
      `UPDATE auction_players SET status = $3
       WHERE auction_id = $1 AND player_id = $2 AND status = 'CURRENT'`,
      [
        auction.id,
        auction.current_player_id,
        auction.status === "PLAYER_SOLD" ? "SOLD" : "UNSOLD",
      ],
    );
    const next = await client.query(
      `SELECT ap.player_id
       FROM auction_players ap
       WHERE ap.auction_id = $1 AND ap.status = 'PENDING'
       ORDER BY ap.order_index
       LIMIT 1 FOR UPDATE`,
      [auction.id],
    );

    if (next.rowCount === 0) {
      const completed = await client.query(
        `UPDATE auction SET status = 'AUCTION_COMPLETED', current_player_id = NULL,
         bid_ends_at = NULL, auction_completed_at = NOW(), updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [auction.id],
      );
      return completed.rows[0];
    }

    await client.query(
      `UPDATE auction_players SET status = 'CURRENT'
       WHERE auction_id = $1 AND player_id = $2`,
      [auction.id, next.rows[0].player_id],
    );
    const advanced = await client.query(
      `UPDATE auction SET status = 'BIDDING', current_player_id = $2,
       current_bid = 0, highest_bidder_team_id = NULL, current_sequence = 0,
       bid_ends_at = NOW() + make_interval(secs => timer_seconds), updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [auction.id, next.rows[0].player_id],
    );
    return advanced.rows[0];
  });
};

export const forceSell = async ({ teamId, amount }) => {
  return withTransaction(async (client) => {
    const auctionRow = await client.query(
      "SELECT * FROM auction ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
    );
    if (auctionRow.rowCount === 0) throw new Error("Auction not initialized");
    const auction = auctionRow.rows[0];
    if (auction.status !== "BIDDING" || !auction.current_player_id) {
      throw new Error("No player is currently being auctioned");
    }

    const playerRow = await client.query(
      "SELECT * FROM players WHERE id = $1 FOR UPDATE",
      [auction.current_player_id],
    );
    const walletRow = await client.query(
      "SELECT * FROM wallets WHERE team_id = $1 FOR UPDATE",
      [teamId],
    );
    const teamRow = await client.query(
      "SELECT * FROM college_teams WHERE id = $1 FOR UPDATE",
      [teamId],
    );
    if (playerRow.rowCount === 0 || playerRow.rows[0].status !== "AVAILABLE") {
      throw new Error("Current player is not available");
    }
    if (walletRow.rowCount === 0) throw new Error("Wallet missing");
    if (teamRow.rowCount === 0 || teamRow.rows[0].status !== "ACTIVE") {
      throw new Error("Team is not active");
    }
    const squadCount = await client.query(
      "SELECT COUNT(*)::int AS count FROM squads WHERE team_id = $1",
      [teamId],
    );
    if (squadCount.rows[0].count >= 18) {
      throw new Error("A team cannot have more than 18 players");
    }

    const saleAmount = Number(amount);
    const available = Number(walletRow.rows[0].available_purse || 0);
    if (
      !Number.isFinite(saleAmount) ||
      saleAmount < Number(playerRow.rows[0].base_price) ||
      saleAmount > available
    ) {
      throw new Error(
        "Sale amount is outside the player's base price and team purse",
      );
    }

    await client.query(
      `INSERT INTO squads (team_id, player_id, acquired_price)
       VALUES ($1, $2, $3)`,
      [teamId, auction.current_player_id, saleAmount],
    );
    await client.query(
      `UPDATE wallets SET available_purse = available_purse - $2,
       spent_purse = spent_purse + $2, updated_at = NOW() WHERE team_id = $1`,
      [teamId, saleAmount],
    );
    await client.query(
      "UPDATE college_teams SET spent = spent + $2, updated_at = NOW() WHERE id = $1",
      [teamId, saleAmount],
    );
    await client.query(
      "UPDATE players SET status = 'SOLD', updated_at = NOW() WHERE id = $1",
      [auction.current_player_id],
    );
    await client.query(
      `UPDATE auction_players SET status = 'SOLD', sold_team_id = $3, sold_price = $4
       WHERE auction_id = $1 AND player_id = $2 AND status = 'CURRENT'`,
      [auction.id, auction.current_player_id, teamId, saleAmount],
    );
    const sold = await client.query(
      `UPDATE auction SET status = 'PLAYER_SOLD', highest_bidder_team_id = $1,
       current_bid = $2, bid_ends_at = NULL, updated_at = NOW()
       WHERE id = $3 RETURNING *`,
      [teamId, saleAmount, auction.id],
    );
    return sold.rows[0];
  });
};

export const markUnsold = async () => {
  return withTransaction(async (client) => {
    const auctionRow = await client.query(
      "SELECT * FROM auction ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
    );
    if (auctionRow.rowCount === 0) throw new Error("Auction not initialized");
    const auction = auctionRow.rows[0];
    if (auction.status !== "BIDDING" || !auction.current_player_id) {
      throw new Error("No player is currently being auctioned");
    }

    await client.query(
      "UPDATE players SET status = 'UNSOLD', updated_at = NOW() WHERE id = $1",
      [auction.current_player_id],
    );
    await client.query(
      `UPDATE auction_players SET status = 'UNSOLD'
       WHERE auction_id = $1 AND player_id = $2 AND status = 'CURRENT'`,
      [auction.id, auction.current_player_id],
    );
    const unsold = await client.query(
      `UPDATE auction SET status = 'PLAYER_UNSOLD', current_bid = 0,
       highest_bidder_team_id = NULL, bid_ends_at = NULL, updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [auction.id],
    );
    return unsold.rows[0];
  });
};

export const getAdminOverview = async () => {
  const auction = await query(
    "SELECT * FROM auction ORDER BY created_at DESC LIMIT 1",
  );
  const connected = await query(
    "SELECT COUNT(*)::int AS count FROM users WHERE is_active = true",
  );
  const teams = await query(
    "SELECT COUNT(*)::int AS count FROM college_teams WHERE status = $1",
    ["ACTIVE"],
  );
  const sold = await query(
    "SELECT COUNT(*)::int AS count FROM auction_players WHERE status = $1",
    ["SOLD"],
  );
  return {
    auction: auction.rows[0] || null,
    connectedUsers: connected.rows[0].count,
    activeTeams: teams.rows[0].count,
    soldPlayers: sold.rows[0].count,
  };
};

export const snapshotTeam = async (teamId) => {
  const team = await query("SELECT * FROM college_teams WHERE id = $1", [
    teamId,
  ]);
  const wallet = await query("SELECT * FROM wallets WHERE team_id = $1", [
    teamId,
  ]);
  const squad = await query(
    `SELECT p.* FROM squads s JOIN players p ON p.id = s.player_id WHERE s.team_id = $1`,
    [teamId],
  );
  return { team: team.rows[0], wallet: wallet.rows[0], squad: squad.rows };
};

export const lockBid = async ({ teamId, amount, playerId }) => {
  return withTransaction(async (client) => {
    const auctionRow = await client.query(
      "SELECT * FROM auction ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
    );
    if (auctionRow.rowCount === 0) throw new Error("Auction not initialized");
    const auction = auctionRow.rows[0];
    if (auction.status !== "BIDDING")
      throw new Error("Auction is not accepting bids");
    if (auction.current_player_id !== playerId)
      throw new Error("Bid is not for the current player");
    if (!auction.bid_ends_at || new Date(auction.bid_ends_at) <= new Date())
      throw new Error("Bidding time has expired");

    const playerRow = await client.query(
      "SELECT id, base_price, status FROM players WHERE id = $1 FOR UPDATE",
      [playerId],
    );
    if (playerRow.rowCount === 0 || playerRow.rows[0].status !== "AVAILABLE")
      throw new Error("Player is not available for auction");

    const walletRow = await client.query(
      "SELECT * FROM wallets WHERE team_id = $1 FOR UPDATE",
      [teamId],
    );
    const teamRow = await client.query(
      "SELECT * FROM college_teams WHERE id = $1 FOR UPDATE",
      [teamId],
    );

    if (walletRow.rowCount === 0) throw new Error("Wallet missing");
    if (teamRow.rowCount === 0 || teamRow.rows[0].status !== "ACTIVE")
      throw new Error("Team is not active");
    const squadCount = await client.query(
      "SELECT COUNT(*)::int AS count FROM squads WHERE team_id = $1",
      [teamId],
    );
    if (squadCount.rows[0].count >= 18) {
      throw new Error("A team cannot have more than 18 players");
    }

    const available = Number(walletRow.rows[0].available_purse || 0);
    if (!Number.isFinite(amount) || amount <= 0 || amount > available) {
      throw new Error("Insufficient purse");
    }

    const nextSequence = Number(auction.current_sequence || 0) + 1;
    const nextBid = Number(auction.current_bid || 0);
    const minimum = auction.highest_bidder_team_id
      ? nextBid + Number(auction.bid_increment || 1)
      : Number(playerRow.rows[0].base_price);
    if (amount < minimum) {
      throw new Error("Bid below minimum increment");
    }

    await client.query(
      `INSERT INTO bids (id, auction_id, player_id, team_id, amount, sequence_number)
      VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)`,
      [auction.id, playerId, teamId, amount, nextSequence],
    );

    await client.query(
      `UPDATE auction SET current_bid = $1, highest_bidder_team_id = $2, current_sequence = $3, bid_ends_at = NOW() + INTERVAL '10 seconds' WHERE id = $4`,
      [amount, teamId, nextSequence, auction.id],
    );

    return { success: true, amount, nextSequence };
  });
};
