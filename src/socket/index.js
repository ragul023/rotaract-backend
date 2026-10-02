import jwt from "jsonwebtoken";

import { env } from "../config/environment.js";
import { query } from "../database/connection.js";

import {
  getAuctionState,
  lockBid,
} from "../services/auctionService.js";

import {
  TEAM_APPROVAL_REQUIRED_MESSAGE,
} from "../middleware/auth.js";


export const attachSocketHandlers = (io) => {

  /*
  |--------------------------------------------------------------------------
  | ACTIVE VOICE ADMIN
  |--------------------------------------------------------------------------
  */

  let activeVoiceAdminId = null;


  /*
  |--------------------------------------------------------------------------
  | STOP VOICE
  |--------------------------------------------------------------------------
  */

  const stopVoiceBroadcast = (adminId) => {

    if (activeVoiceAdminId !== adminId) {
      return;
    }

    activeVoiceAdminId = null;

    io
      .to("auction-room")
      .emit("voice_broadcast_stopped");
  };


  /*
  |--------------------------------------------------------------------------
  | SOCKET AUTHENTICATION
  |--------------------------------------------------------------------------
  */

  io.use(async (socket, next) => {

    try {

      const token =
        socket.handshake.auth?.token;

      if (!token) {
        return next(
          new Error("Authentication required")
        );
      }


      const decoded = jwt.verify(
        token,
        env.JWT_SECRET
      );


      if (
        !decoded ||
        typeof decoded !== "object" ||
        !decoded.userId
      ) {
        return next(
          new Error("Invalid authentication token")
        );
      }


      const result = await query(
        `
        SELECT
          id,
          email,
          role,
          name
        FROM users
        WHERE id = $1
        LIMIT 1
        `,
        [decoded.userId]
      );


      if (result.rowCount === 0) {

        return next(
          new Error("User not found")
        );
      }


      socket.user = {
        ...result.rows[0],

        teamId:
          decoded.teamId || null,
      };


      return next();

    } catch (error) {

      console.error(
        "[SOCKET AUTH ERROR]",
        error
      );

      return next(
        new Error("Invalid token")
      );
    }
  });


  /*
  |--------------------------------------------------------------------------
  | CONNECTION
  |--------------------------------------------------------------------------
  */

  io.on("connection", (socket) => {

    console.log(
      `[SOCKET] Authenticated user connected: ${socket.id}`,
      {
        userId: socket.user?.id,
        role: socket.user?.role,
      }
    );


    /*
    |--------------------------------------------------------------------------
    | ADMIN ROOM
    |--------------------------------------------------------------------------
    */

    if (
      [
        "SUPER_ADMIN",
        "AUCTION_ADMIN",
      ].includes(socket.user.role)
    ) {

      socket.join("admin-room");
    }


    /*
    |--------------------------------------------------------------------------
    | JOIN GAME
    |--------------------------------------------------------------------------
    */

    socket.on(
      "join_game",
      async () => {

        try {

          socket.join("auction-room");


          if (socket.user.teamId) {

            socket.join(
              `team:${socket.user.teamId}`
            );
          }


          socket.emit(
            "voice_broadcast_status",
            {
              adminId:
                activeVoiceAdminId,
            }
          );


          socket.emit(
            "participant_connected",
            {
              user:
                socket.user.name,

              role:
                socket.user.role,
            }
          );


          const state =
            await getAuctionState();


          socket.emit(
            "auction_state",
            {
              state,
            }
          );


          io
            .to("auction-room")
            .emit(
              "auction_state",
              {
                type:
                  "participant_connected",

                user:
                  socket.user.name,

                role:
                  socket.user.role,

                connected:
                  true,
              }
            );

        } catch (error) {

          console.error(
            "[SOCKET] join_game error:",
            error
          );

          socket.emit(
            "auction_error",
            {
              message:
                "Unable to load auction state",
            }
          );
        }
      }
    );


    /*
    |--------------------------------------------------------------------------
    | VOICE STATUS
    |--------------------------------------------------------------------------
    */

    socket.on(
      "voice_status_request",
      () => {

        socket.emit(
          "voice_broadcast_status",
          {
            adminId:
              activeVoiceAdminId,
          }
        );
      }
    );


    /*
    |--------------------------------------------------------------------------
    | VOICE BROADCAST START
    |--------------------------------------------------------------------------
    */

    socket.on(
      "voice_broadcast_start",
      (acknowledge) => {

        try {

          const isAdmin =
            [
              "SUPER_ADMIN",
              "AUCTION_ADMIN",
            ].includes(
              socket.user.role
            );


          const joinedAuction =
            socket.rooms.has(
              "auction-room"
            );


          if (
            !isAdmin ||
            !joinedAuction
          ) {

            acknowledge?.({
              success: false,
              message:
                "Admin access required",
            });

            return;
          }


          if (
            activeVoiceAdminId &&
            activeVoiceAdminId !== socket.id
          ) {

            acknowledge?.({
              success: false,
              message:
                "Another admin is broadcasting",
            });

            return;
          }


          activeVoiceAdminId =
            socket.id;


          io
            .to("auction-room")
            .emit(
              "voice_broadcast_started",
              {
                adminId:
                  socket.id,
              }
            );


          acknowledge?.({
            success: true,
          });

        } catch (error) {

          console.error(
            "[SOCKET] voice start error:",
            error
          );

          acknowledge?.({
            success: false,
            message:
              "Unable to start voice broadcast",
          });
        }
      }
    );


    /*
    |--------------------------------------------------------------------------
    | VOICE BROADCAST STOP
    |--------------------------------------------------------------------------
    */

    socket.on(
      "voice_broadcast_stop",
      () => {

        if (
          [
            "SUPER_ADMIN",
            "AUCTION_ADMIN",
          ].includes(
            socket.user.role
          )
        ) {

          stopVoiceBroadcast(
            socket.id
          );
        }
      }
    );


    /*
    |--------------------------------------------------------------------------
    | VOICE LISTENER JOIN
    |--------------------------------------------------------------------------
    */

    socket.on(
      "voice_listener_join",
      () => {

        if (
          socket.user.role !==
            "PARTICIPANT"
        ) {
          return;
        }


        if (!socket.user.teamId) {
          return;
        }


        if (
          !socket.rooms.has(
            "auction-room"
          )
        ) {
          return;
        }


        if (!activeVoiceAdminId) {
          return;
        }


        io
          .to(activeVoiceAdminId)
          .emit(
            "voice_listener_joined",
            {
              listenerId:
                socket.id,
            }
          );
      }
    );


    /*
    |--------------------------------------------------------------------------
    | WEBRTC VOICE SIGNAL
    |--------------------------------------------------------------------------
    */

    socket.on(
      "voice_signal",
      (payload) => {

        try {

          if (
            !payload ||
            !payload.targetId ||
            !payload.signal
          ) {
            return;
          }


          const target =
            io.sockets.sockets.get(
              payload.targetId
            );


          if (!target) {
            return;
          }


          const senderInAuction =
            socket.rooms.has(
              "auction-room"
            );


          const targetInAuction =
            target.rooms.has(
              "auction-room"
            );


          if (
            !senderInAuction ||
            !targetInAuction
          ) {
            return;
          }


          const senderIsAdmin =
            socket.id ===
            activeVoiceAdminId;


          const targetIsAdmin =
            target.id ===
            activeVoiceAdminId;


          if (
            !senderIsAdmin &&
            !targetIsAdmin
          ) {
            return;
          }


          if (
            senderIsAdmin &&
            target.user.role !==
              "PARTICIPANT"
          ) {
            return;
          }


          if (
            targetIsAdmin &&
            socket.user.role !==
              "PARTICIPANT"
          ) {
            return;
          }


          target.emit(
            "voice_signal",
            {
              fromId:
                socket.id,

              signal:
                payload.signal,
            }
          );

        } catch (error) {

          console.error(
            "[SOCKET] voice signal error:",
            error
          );
        }
      }
    );


    /*
    |--------------------------------------------------------------------------
    | PLACE BID
    |--------------------------------------------------------------------------
    */

    socket.on(
      "place_bid",
      async (
        payload,
        acknowledge
      ) => {

        try {

          /*
           * Role check
           */

          if (
            socket.user.role !==
              "PARTICIPANT" ||
            !socket.user.teamId
          ) {

            throw new Error(
              "Only team participants can place bids"
            );
          }


          /*
           * Team approval check
           */

          const team =
            await query(
              `
              SELECT
                registration_status
              FROM college_teams
              WHERE id = $1
              LIMIT 1
              `,
              [
                socket.user.teamId,
              ]
            );


          if (
            team.rowCount === 0 ||
            team.rows[0]
              .registration_status !==
              "CONFIRMED"
          ) {

            const approvalError =
              new Error(
                TEAM_APPROVAL_REQUIRED_MESSAGE
              );

            approvalError.code =
              "TEAM_PAYMENT_NOT_APPROVED";

            throw approvalError;
          }


          /*
           * Validate bid
           */

          if (
            !payload ||
            typeof payload.playerId !==
              "string" ||
            typeof payload.amount !==
              "number" ||
            !Number.isFinite(
              payload.amount
            ) ||
            payload.amount < 0
          ) {

            throw new Error(
              "Invalid bid"
            );
          }


          /*
           * Lock bid
           */

          const result =
            await lockBid({
              teamId:
                socket.user.teamId,

              amount:
                payload.amount,

              playerId:
                payload.playerId,
            });


          /*
           * Get latest state
           */

          const state =
            await getAuctionState();


          /*
           * Create update
           */

          const update = {

            bidder:
              socket.user.name,

            amount:
              result.amount,

            teamId:
              socket.user.teamId,

            playerId:
              payload.playerId,

            sequence:
              result.nextSequence,

            status:
              "accepted",
          };


          /*
           * Broadcast
           */

          io
            .to("auction-room")
            .emit(
              "auction_state",
              {
                state,
              }
            );


          io
            .to("auction-room")
            .emit(
              "bid_updated",
              update
            );


          /*
           * ACK
           */

          acknowledge?.({
            success: true,
            bid: update,
          });

        } catch (error) {

          console.error(
            "[SOCKET] Bid failed:",
            error
          );


          const message =
            error?.message ||
            "Bid failed";


          acknowledge?.({
            success: false,

            code:
              error?.code,

            message,
          });


          socket.emit(
            "bid_rejected",
            {
              code:
                error?.code,

              message,
            }
          );
        }
      }
    );


    /*
    |--------------------------------------------------------------------------
    | DISCONNECT
    |--------------------------------------------------------------------------
    */

    socket.on(
      "disconnect",
      (reason) => {

        console.log(
          `[SOCKET] Disconnected: ${socket.id} | ${reason}`
        );


        if (
          socket.id ===
          activeVoiceAdminId
        ) {

          stopVoiceBroadcast(
            socket.id
          );

        } else if (
          activeVoiceAdminId &&
          socket.user?.role ===
            "PARTICIPANT"
        ) {

          io
            .to(activeVoiceAdminId)
            .emit(
              "voice_listener_left",
              {
                listenerId:
                  socket.id,
              }
            );
        }


        io
          .to("auction-room")
          .emit(
            "participant_disconnected",
            {
              user:
                socket.user?.name ||
                "Unknown",
            }
          );
      }
    );
  });
};