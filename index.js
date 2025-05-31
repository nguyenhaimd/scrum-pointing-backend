// ✅ UPDATED index.js with 30-minute “grace period” on disconnect
// Allows a mobile user to go offline briefly without getting kicked out immediately.

const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
app.use(cors());

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// ─── CHANGE HERE: Set grace period to 30 minutes ─────────────────────────────
const GRACE_PERIOD_MS = 30 * 60 * 1000; // 30 minutes (1800000 ms)

//
// rooms structure:
//
// rooms[roomName] = {
//   participants: [ 'Alice', 'Bob', 'Carol', ... ],
//   roles:        { 'Alice': 'Developer', 'Bob': 'Scrum Master', ... },
//   avatars:      { 'Alice': '🐶', 'Bob': '🐱', ... },
//   moods:        { 'Alice': '😎', 'Bob': '☕', ... },
//   votes:        { 'Alice': null, 'Bob': null, ... },
//   typing:       [ 'Alice', ... ],
//   currentStory: 'User login page',
//   disconnectTimers: { 'Alice': TimeoutObject, ... },
//   devices:      { 'Alice': 'mobile', 'Bob': 'desktop', ... }
// }
//
const rooms = {};

io.on('connection', (socket) => {
  let currentRoom = null;
  let nickname = null;

  //
  // ─── JOIN EVENT ───────────────────────────────────────────────────────────────
  //
  // When a client emits "join", they supply: { nickname, room, role, avatar, emoji, device }
  // If they reconnect before the grace period is up, clear the timer and bring them back online.
  //
  socket.on('join', ({ nickname: name, room, role, avatar, emoji, device }) => {
    nickname = name;
    currentRoom = room;
    socket.join(room);
    socket.nickname = nickname;

    // If this room doesn't exist yet, initialize it
    if (!rooms[room]) {
      rooms[room] = {
        participants: [],
        roles: {},
        avatars: {},
        moods: {},
        votes: {},
        typing: [],
        currentStory: '',
        disconnectTimers: {},
        devices: {}
      };
    }

    const r = rooms[room];

    // If they were already in participants & had a pending disconnect timer, cancel it
    if (r.participants.includes(nickname) && r.disconnectTimers[nickname]) {
      clearTimeout(r.disconnectTimers[nickname]);
      delete r.disconnectTimers[nickname];
      // They had been marked offline; we’ll simply mark them online again below
    } else if (!r.participants.includes(nickname)) {
      // First time joining in this room: add to participants
      r.participants.push(nickname);
    }

    // (Re)set their role/avatar/mood/vote/device
    r.roles[nickname]   = role;
    r.avatars[nickname] = avatar;
    r.moods[nickname]   = emoji;
    r.votes[nickname]   = null;        // reset any previous vote
    r.devices[nickname] = device;

    // Recompute who is currently connected (online) in this room
    const connectedNicknames = [...io.sockets.sockets.values()]
      .filter(s => s.rooms.has(room))
      .map(s => s.nickname);

    // Emit the updated participant list (including device info)
    io.to(room).emit('participantsUpdate', {
      names:     r.participants,
      roles:     r.roles,
      avatars:   r.avatars,
      moods:     r.moods,
      connected: connectedNicknames,
      devices:   r.devices
    });

    // Let everyone else know someone joined/rejoined
    socket.to(room).emit('userJoined', nickname);
  });


  //
  // ─── VOTE / REVEAL / END SESSION / CHAT / etc. ─────────────────────────────────
  //
  socket.on('vote', ({ nickname: name, point }) => {
    if (rooms[currentRoom]) {
      rooms[currentRoom].votes[name] = point;
      io.to(currentRoom).emit('updateVotes', rooms[currentRoom].votes);
    }
  });

  socket.on('revealVotes', () => {
    if (!rooms[currentRoom]) return;
    const roomObj = rooms[currentRoom];
    const votes = roomObj.votes || {};
    const freq = {};

    // Only count votes from connected Developers
    const connectedDevelopers = [...io.sockets.sockets.values()]
      .filter(s => s.rooms.has(currentRoom) && roomObj.roles[s.nickname] === 'Developer')
      .map(s => s.nickname);

    const validVoters = connectedDevelopers.filter(name =>
      votes[name] !== null && votes[name] !== undefined && votes[name] !== ''
    );

    validVoters.forEach(name => {
      const p = Number(votes[name]);
      if (!isNaN(p)) {
        freq[p] = (freq[p] || 0) + 1;
      }
    });

    // Determine consensus, build voteList, etc.
    const maxCount = Math.max(...Object.values(freq), 0);
    const consensus = Object.keys(freq)
      .filter(k => freq[k] === maxCount)
      .map(Number);

    const voteList = validVoters.map(name => ({
      name,
      avatar: roomObj.avatars[name],
      point:  votes[name]
    }));

    const timestamp = new Date().toLocaleTimeString([], {
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });

    // Broadcast the reveal event
    io.to(currentRoom).emit('revealVotes', { story: roomObj.currentStory });

    // Send detailed summary to Scrum Masters only
    const scrumMasters = roomObj.participants.filter(p => roomObj.roles[p] === 'Scrum Master');
    for (const smName of scrumMasters) {
      const smSocket = [...io.sockets.sockets.values()].find(
        s => s.rooms.has(currentRoom) && s.nickname === smName
      );
      if (smSocket) {
        smSocket.emit('teamChat', {
          type: 'voteSummary',
          summary: {
            story:     roomObj.currentStory || 'Untitled Story',
            consensus,
            votes:     voteList,
            timestamp,
            expand:    false
          }
        });
      }
    }
  });

  socket.on('endSession', () => {
    if (rooms[currentRoom]) {
      rooms[currentRoom].votes = {};
      rooms[currentRoom].currentStory = '';
      io.to(currentRoom).emit('sessionEnded');
    }
  });

  socket.on('forceRemoveUser', (targetNickname) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const roomObj = rooms[currentRoom];
    const senderRole = roomObj.roles[nickname];
    if (senderRole !== 'Scrum Master') return;

    if (!roomObj.participants.includes(targetNickname)) return;

    // If that user is still connected, do nothing
    const isStillConnected = [...io.sockets.sockets.values()]
      .some(s => s.rooms.has(currentRoom) && s.nickname === targetNickname);
    if (isStillConnected) {
      console.log(`🚫 Attempted to remove online user: ${targetNickname}`);
      return;
    }

    // Cancel any pending disconnect timer if it exists
    if (roomObj.disconnectTimers[targetNickname]) {
      clearTimeout(roomObj.disconnectTimers[targetNickname]);
      delete roomObj.disconnectTimers[targetNickname];
    }

    // Now remove them from participants completely
    roomObj.participants = roomObj.participants.filter(p => p !== targetNickname);
    delete roomObj.roles[targetNickname];
    delete roomObj.avatars[targetNickname];
    delete roomObj.moods[targetNickname];
    delete roomObj.votes[targetNickname];
    delete roomObj.devices[targetNickname];

    // Broadcast updated participants (with devices and connected lists)
    const stillConnected = [...io.sockets.sockets.values()]
      .filter(s => s.rooms.has(currentRoom))
      .map(s => s.nickname);

    io.to(currentRoom).emit('participantsUpdate', {
      names:     roomObj.participants,
      roles:     roomObj.roles,
      avatars:   roomObj.avatars,
      moods:     roomObj.moods,
      connected: stillConnected,
      devices:   roomObj.devices
    });

    io.to(currentRoom).emit('userLeft', targetNickname);
    console.log(`✅ ${targetNickname} removed by Scrum Master`);
  });

  // End entire pointing session (Scrum Master only)
  socket.on('endPointingSession', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    io.to(currentRoom).emit('sessionTerminated');
    delete rooms[currentRoom];
  });

  socket.on('startSession', ({ title, room }) => {
    if (rooms[room]) {
      rooms[room].votes = {};
      rooms[room].participants.forEach(p => (rooms[room].votes[p] = null));
      rooms[room].currentStory = title;
      io.to(room).emit('startSession', title);
    }
  });

  socket.on('teamChat', ({ sender, text }) => {
    if (currentRoom && text) {
      io.to(currentRoom).emit('teamChat', { sender, text });
    }
  });

  socket.on('emojiReaction', ({ sender, emoji }) => {
    if (currentRoom) {
      io.to(currentRoom).emit('emojiReaction', { sender, emoji });
    }
  });

  socket.on('userTyping', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const roomObj = rooms[currentRoom];
    if (!roomObj.typing.includes(nickname)) roomObj.typing.push(nickname);
    io.to(currentRoom).emit('typingUpdate', roomObj.typing);
    setTimeout(() => {
      roomObj.typing = roomObj.typing.filter(name => name !== nickname);
      io.to(currentRoom).emit('typingUpdate', roomObj.typing);
    }, 3000);
  });

  socket.on('updateMood', ({ nickname: name, emoji }) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const roomObj = rooms[currentRoom];
    roomObj.moods[name] = emoji;

    // Recalculate who is online
    const connectedNow = [...io.sockets.sockets.values()]
      .filter(s => s.rooms.has(currentRoom))
      .map(s => s.nickname);

    io.to(currentRoom).emit('participantsUpdate', {
      names:     roomObj.participants,
      roles:     roomObj.roles,
      avatars:   roomObj.avatars,
      moods:     roomObj.moods,
      connected: connectedNow,
      devices:   roomObj.devices
    });
  });

  //
  // ─── LOGOUT HANDLER ────────────────────────────────────────────────────────────
  //
  socket.on('logout', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const roomObj = rooms[currentRoom];

    // Cancel any pending disconnect timer (if there is one)
    if (roomObj.disconnectTimers[nickname]) {
      clearTimeout(roomObj.disconnectTimers[nickname]);
      delete roomObj.disconnectTimers[nickname];
    }

    // Remove user immediately
    roomObj.participants = roomObj.participants.filter(p => p !== nickname);
    delete roomObj.votes[nickname];
    delete roomObj.roles[nickname];
    delete roomObj.avatars[nickname];
    delete roomObj.moods[nickname];
    delete roomObj.devices[nickname];

    // Who is still connected?
    const connectedAfterLogout = [...io.sockets.sockets.values()]
      .filter(s => s.rooms.has(currentRoom))
      .map(s => s.nickname);

    io.to(currentRoom).emit('participantsUpdate', {
      names:     roomObj.participants,
      roles:     roomObj.roles,
      avatars:   roomObj.avatars,
      moods:     roomObj.moods,
      connected: connectedAfterLogout,
      devices:   roomObj.devices
    });

    socket.to(currentRoom).emit('userLeft', nickname);
    socket.leave(currentRoom);
    console.log(`${nickname} logged out manually.`);

    // Clean up empty room
    if (roomObj.participants.length === 0) {
      delete rooms[currentRoom];
      console.log(`🧹 Room "${currentRoom}" deleted because it became empty.`);
    }
  });

  //
  // ─── DISCONNECT HANDLER WITH GRACE PERIOD ──────────────────────────────────────
  //
  socket.on('disconnect', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const roomObj = rooms[currentRoom];

    // 1) Immediately mark the user as “offline” in the participants list
    const connectedNow = [...io.sockets.sockets.values()]
      .filter(s => s.rooms.has(currentRoom))
      .map(s => s.nickname);

    // Broadcast that they are now disconnected (but still in the participant list)
    io.to(currentRoom).emit('participantsUpdate', {
      names:     roomObj.participants,
      roles:     roomObj.roles,
      avatars:   roomObj.avatars,
      moods:     roomObj.moods,
      connected: connectedNow,
      devices:   roomObj.devices
    });
    io.to(currentRoom).emit('userLeft', nickname);
    console.log(`⚠️ ${nickname} disconnected; waiting ${GRACE_PERIOD_MS/1000}s before removal.`);

    // 2) Start a timer to remove them permanently after GRACE_PERIOD_MS
    if (roomObj.disconnectTimers[nickname]) {
      clearTimeout(roomObj.disconnectTimers[nickname]);
    }
    roomObj.disconnectTimers[nickname] = setTimeout(() => {
      // Only remove them if they haven’t reconnected in the meantime
      if (![...io.sockets.sockets.values()].some(s => s.rooms.has(currentRoom) && s.nickname === nickname)) {
        roomObj.participants = roomObj.participants.filter(p => p !== nickname);
        delete roomObj.roles[nickname];
        delete roomObj.avatars[nickname];
        delete roomObj.moods[nickname];
        delete roomObj.votes[nickname];
        delete roomObj.devices[nickname];
        delete roomObj.disconnectTimers[nickname];

        // Broadcast final removal
        const stillConnected = [...io.sockets.sockets.values()]
          .filter(s => s.rooms.has(currentRoom))
          .map(s => s.nickname);

        io.to(currentRoom).emit('participantsUpdate', {
          names:     roomObj.participants,
          roles:     roomObj.roles,
          avatars:   roomObj.avatars,
          moods:     roomObj.moods,
          connected: stillConnected,
          devices:   roomObj.devices
        });
        io.to(currentRoom).emit('userLeft', nickname);
        console.log(`✅ ${nickname} permanently removed after grace period.`);
      }
    }, GRACE_PERIOD_MS);
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`✅ Scrum Pointing server running on port ${PORT}`));