// ✅ Full Backend index.js for Scrum Pointing App (no grace period)

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

// rooms structure:
// rooms[roomName] = {
//   participants: [nickname, ...],
//   roles: { nickname: role, ... },
//   avatars: { nickname: avatarEmoji, ... },
//   moods: { nickname: emoji, ... },
//   votes: { nickname: null-or-point, ... },
//   typing: [nickname, ...],
//   currentStory: string,
//   devices: { nickname: 'desktop'|'mobile', ... }
// }
const rooms = {};

io.on('connection', (socket) => {
  let currentRoom = null;
  let nickname    = null;

  // ─── Join Handler ──────────────────────────────────────────────────────────────
  socket.on('join', ({ nickname: name, room, role, avatar, emoji, device }) => {
    nickname    = name;
    currentRoom = room;
    socket.join(room);
    socket.nickname = nickname;

    if (!rooms[room]) {
      rooms[room] = {
        participants: [],
        roles: {},
        avatars: {},
        moods: {},
        votes: {},
        typing: [],
        currentStory: '',
        devices: {}
      };
    }

    const r = rooms[room];

    // If fresh join (not rejoin), add them
    if (!r.participants.includes(nickname)) {
      r.participants.push(nickname);
    }

    r.roles[nickname]   = role;
    r.avatars[nickname] = avatar;
    r.moods[nickname]   = emoji;
    r.votes[nickname]   = null;
    r.devices[nickname] = device;

    // Compute connected list
    const connectedNicknames = Array.from(io.sockets.sockets.values())
      .filter(s => s.rooms.has(room))
      .map(s => s.nickname);

    io.to(room).emit('participantsUpdate', {
      names:      r.participants,
      roles:      r.roles,
      avatars:    r.avatars,
      moods:      r.moods,
      connected:  connectedNicknames,
      devices:    r.devices
    });

    socket.to(room).emit('userJoined', nickname);
  });

  // ─── Vote Handler ──────────────────────────────────────────────────────────────
  socket.on('vote', ({ nickname: name, point }) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    rooms[currentRoom].votes[name] = point;
    io.to(currentRoom).emit('updateVotes', rooms[currentRoom].votes);
  });

  // ─── Reveal Votes ──────────────────────────────────────────────────────────────
  socket.on('revealVotes', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    const votes = room.votes || {};
    const freq = {};

    // Only count Developers who are connected
    const connectedDevelopers = Array.from(io.sockets.sockets.values())
      .filter(s => s.rooms.has(currentRoom) && room.roles[s.nickname] === 'Developer')
      .map(s => s.nickname);

    const validVoters = connectedDevelopers.filter(name =>
      votes[name] !== null && votes[name] !== undefined && votes[name] !== ''
    );

    validVoters.forEach((name) => {
      const point = Number(votes[name]);
      if (!isNaN(point)) {
        freq[point] = (freq[point] || 0) + 1;
      }
    });

    const maxCount = Math.max(...Object.values(freq), 0);
    const consensus = Object.keys(freq)
      .filter(k => freq[k] === maxCount)
      .map(Number);

    const voteList = validVoters.map((name) => ({
      name,
      avatar: room.avatars[name],
      point: votes[name],
    }));

    const timestamp = new Date().toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });

    io.to(currentRoom).emit('revealVotes', { story: room.currentStory });

    // Send vote summary to Scrum Masters only
    const scrumMasters = room.participants.filter(p => room.roles[p] === 'Scrum Master');
    scrumMasters.forEach((smName) => {
      const smSocket = Array.from(io.sockets.sockets.values()).find(
        s => s.rooms.has(currentRoom) && s.nickname === smName
      );
      if (smSocket) {
        smSocket.emit('teamChat', {
          type: 'voteSummary',
          summary: {
            story: room.currentStory || 'Untitled Story',
            consensus,
            votes: voteList,
            timestamp,
            expand: false
          }
        });
      }
    });
  });

  // ─── End Session Handler ───────────────────────────────────────────────────────
  socket.on('endSession', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    rooms[currentRoom].votes = {};
    rooms[currentRoom].currentStory = '';
    io.to(currentRoom).emit('sessionEnded');
  });

  // ─── Force Remove User (Scrum Master only) ─────────────────────────────────────
  socket.on('forceRemoveUser', (targetNickname) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const roomObj = rooms[currentRoom];
    const senderRole = roomObj.roles[nickname];
    if (senderRole !== 'Scrum Master') return;
    if (!roomObj.participants.includes(targetNickname)) return;

    // Check if still connected
    const isStillConnected = Array.from(io.sockets.sockets.values())
      .some(s => s.rooms.has(currentRoom) && s.nickname === targetNickname);

    if (isStillConnected) {
      console.log(`Attempted to remove still‐connected user: ${targetNickname}`);
      return;
    }

    // Remove from data structures
    roomObj.participants = roomObj.participants.filter(p => p !== targetNickname);
    delete roomObj.roles[targetNickname];
    delete roomObj.avatars[targetNickname];
    delete roomObj.moods[targetNickname];
    delete roomObj.votes[targetNickname];
    delete roomObj.devices[targetNickname];

    const connectedNow = Array.from(io.sockets.sockets.values())
      .filter(s => s.rooms.has(currentRoom))
      .map(s => s.nickname);

    io.to(currentRoom).emit('participantsUpdate', {
      names:      roomObj.participants,
      roles:      roomObj.roles,
      avatars:    roomObj.avatars,
      moods:      roomObj.moods,
      connected:  connectedNow,
      devices:    roomObj.devices
    });
    io.to(currentRoom).emit('userLeft', targetNickname);
    console.log(`${targetNickname} removed by Scrum Master`);
  });

  // ─── End Entire Pointing Session (Scrum Master only) ───────────────────────────
  socket.on('endPointingSession', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    io.to(currentRoom).emit('sessionTerminated');
    delete rooms[currentRoom];
  });

  // ─── Start Session (Add story to queue) ────────────────────────────────────────
  socket.on('startSession', ({ title, room }) => {
    if (rooms[room]) {
      rooms[room].votes = {};
      rooms[room].participants.forEach(p => { rooms[room].votes[p] = null; });
      rooms[room].currentStory = title;
      io.to(room).emit('startSession', title);
    }
  });

  // ─── Team Chat ─────────────────────────────────────────────────────────────────
  socket.on('teamChat', ({ sender, text }) => {
    if (currentRoom && text) {
      io.to(currentRoom).emit('teamChat', { sender, text });
    }
  });

  // ─── Emoji Reaction ─────────────────────────────────────────────────────────────
  socket.on('emojiReaction', ({ sender, emoji }) => {
    if (currentRoom) {
      io.to(currentRoom).emit('emojiReaction', { sender, emoji });
    }
  });

  // ─── User Typing Indicator ─────────────────────────────────────────────────────
  socket.on('userTyping', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const r = rooms[currentRoom];
    if (!r.typing.includes(nickname)) r.typing.push(nickname);
    io.to(currentRoom).emit('typingUpdate', r.typing);
    setTimeout(() => {
      r.typing = r.typing.filter(name => name !== nickname);
      io.to(currentRoom).emit('typingUpdate', r.typing);
    }, 3000);
  });

  // ─── Update Mood ───────────────────────────────────────────────────────────────
  socket.on('updateMood', ({ nickname: name, emoji }) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    rooms[currentRoom].moods[name] = emoji;
    const connectedNow = Array.from(io.sockets.sockets.values())
      .filter(s => s.rooms.has(currentRoom))
      .map(s => s.nickname);

    io.to(currentRoom).emit('participantsUpdate', {
      names:      rooms[currentRoom].participants,
      roles:      rooms[currentRoom].roles,
      avatars:    rooms[currentRoom].avatars,
      moods:      rooms[currentRoom].moods,
      connected:  connectedNow,
      devices:    rooms[currentRoom].devices
    });
  });

  // ─── Logout Handler (Explicit) ─────────────────────────────────────────────────
  socket.on('logout', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const r = rooms[currentRoom];

    // Immediately remove user from that room
    r.participants = r.participants.filter(p => p !== nickname);
    delete r.votes[nickname];
    delete r.roles[nickname];
    delete r.avatars[nickname];
    delete r.moods[nickname];
    delete r.devices[nickname];

    io.to(currentRoom).emit('participantsUpdate', {
      names:   r.participants,
      roles:   r.roles,
      avatars: r.avatars,
      moods:   r.moods,
      devices: r.devices
    });
    socket.to(currentRoom).emit('userLeft', nickname);

    socket.leave(currentRoom);
    console.log(`${nickname} logged out manually.`);

    // Clean up empty room
    if (r.participants.length === 0) {
      delete rooms[currentRoom];
    }
  });

  // ─── Disconnect Handler (No Grace Period) ─────────────────────────────────────
  socket.on('disconnect', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const r = rooms[currentRoom];

    // Immediately broadcast who is still connected
    const connectedNow = Array.from(io.sockets.sockets.values())
      .filter(s => s.rooms.has(currentRoom))
      .map(s => s.nickname);

    io.to(currentRoom).emit('participantsUpdate', {
      names:      r.participants,
      roles:      r.roles,
      avatars:    r.avatars,
      moods:      r.moods,
      connected:  connectedNow,
      devices:    r.devices
    });

    console.log(`${nickname} disconnected (no grace period).`);

    // Note: We do NOT remove the user from r.participants here.
    // That way they remain “Offline” until the Scrum Master forces removal.
    // If you did want to remove them immediately, uncomment below:
    //
    // r.participants = r.participants.filter(p => p !== nickname);
    // delete r.votes[nickname];
    // delete r.roles[nickname];
    // delete r.avatars[nickname];
    // delete r.moods[nickname];
    // delete r.devices[nickname];
    // io.to(currentRoom).emit('participantsUpdate', { ... });
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`✅ Scrum Pointing server running on port ${PORT}`));