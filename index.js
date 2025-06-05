// ✅ Full Backend index.js for Scrum Pointing App (with “haifetti” broadcast)

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

// No more grace period in this version
const rooms = {}; 
// rooms structure: {
//   roomName: { 
//     participants: [], 
//     roles: {}, 
//     avatars: {}, 
//     moods: {}, 
//     votes: {}, 
//     typing: [], 
//     currentStory: '', 
//     devices: {}, 
//     disconnectTimers: {} 
//   }
// }

io.on('connection', (socket) => {
  let currentRoom = null;
  let nickname    = null;

  //
  // ─── JOIN HANDLER ──────────────────────────────────────────────────────────────
  //
  socket.on('join', ({ nickname: name, room, role, avatar, emoji, device }) => {
    nickname = name;
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
        devices: {},
        disconnectTimers: {}
      };
    }

    const r = rooms[room];

    if (!r.participants.includes(nickname)) {
      r.participants.push(nickname);
    } else if (r.disconnectTimers[nickname]) {
      clearTimeout(r.disconnectTimers[nickname]);
      delete r.disconnectTimers[nickname];
    }

    r.roles[nickname]   = role;
    r.avatars[nickname] = avatar;
    r.moods[nickname]   = emoji;
    r.votes[nickname]   = null;
    r.devices[nickname] = device;

    const connectedNicknames = [...io.sockets.sockets.values()]
      .filter(s => s.rooms.has(room))
      .map(s => s.nickname);

    io.to(room).emit('participantsUpdate', {
      names: r.participants,
      roles: r.roles,
      avatars: r.avatars,
      moods: r.moods,
      connected: connectedNicknames,
      devices: r.devices
    });

    socket.to(room).emit('userJoined', nickname);
  });

  //
  // ─── VOTE HANDLER ─────────────────────────────────────────────────────────────█
  //
  socket.on('vote', ({ nickname: name, point }) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    rooms[currentRoom].votes[name] = point;
    io.to(currentRoom).emit('updateVotes', rooms[currentRoom].votes);
  });

  //
  // ─── REVEAL VOTES ──────────────────────────────────────────────────────────────
  //
  socket.on('revealVotes', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const roomData = rooms[currentRoom];
    const votes = roomData.votes || {};
    const freq = {};

    // Connected developers only
    const connectedDevelopers = [...io.sockets.sockets.values()]
      .filter(s => s.rooms.has(currentRoom) && roomData.roles[s.nickname] === 'Developer')
      .map(s => s.nickname);

    const validVoters = connectedDevelopers.filter(name =>
      votes[name] !== null && votes[name] !== undefined && votes[name] !== ''
    );

    validVoters.forEach(name => {
      const point = Number(votes[name]);
      if (!isNaN(point)) {
        freq[point] = (freq[point] || 0) + 1;
      }
    });

    const maxFreq = Math.max(...Object.values(freq), 0);
    const consensus = Object.keys(freq)
      .filter(k => freq[k] === maxFreq)
      .map(Number);

    const voteList = validVoters.map(name => ({
      name,
      avatar: roomData.avatars[name],
      point: votes[name]
    }));

    const timestamp = new Date().toLocaleTimeString([], {
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });

    io.to(currentRoom).emit('revealVotes', { story: roomData.currentStory });

    const scrumMasters = roomData.participants.filter(p => roomData.roles[p] === 'Scrum Master');
    for (const smName of scrumMasters) {
      const smSocket = [...io.sockets.sockets.values()].find(
        s => s.rooms.has(currentRoom) && s.nickname === smName
      );
      if (smSocket) {
        smSocket.emit('teamChat', {
          type: 'voteSummary',
          summary: {
            story: roomData.currentStory || 'Untitled Story',
            consensus,
            votes: voteList,
            timestamp,
            expand: false
          }
        });
      }
    }
  });

  //
  // ─── END SESSION (SCRUM MASTER) ─────────────────────────────────────────────────
  //
  socket.on('endSession', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    rooms[currentRoom].votes = {};
    rooms[currentRoom].currentStory = '';
    io.to(currentRoom).emit('sessionEnded');
  });

  //
  // ─── FORCE REMOVE USER (ONLY SCRUM MASTER, and only if offline) ───────────────
  //
  socket.on('forceRemoveUser', (targetNickname) => {
    if (!currentRoom || !rooms[currentRoom]) return;

    const roomData = rooms[currentRoom];
    const senderRole = roomData.roles[nickname];
    if (senderRole !== 'Scrum Master') return;
    if (!roomData.participants.includes(targetNickname)) return;

    // If still connected, do not remove
    const isStillConnected = [...io.sockets.sockets.values()]
      .some(s => s.rooms.has(currentRoom) && s.nickname === targetNickname);

    if (isStillConnected) {
      console.log(`🚫 Attempted to remove online user: ${targetNickname}`);
      return;
    }

    roomData.participants = roomData.participants.filter(p => p !== targetNickname);
    delete roomData.roles[targetNickname];
    delete roomData.avatars[targetNickname];
    delete roomData.moods[targetNickname];
    delete roomData.votes[targetNickname];
    delete roomData.devices[targetNickname];

    const stillConnected = [...io.sockets.sockets.values()]
      .filter(s => s.rooms.has(currentRoom))
      .map(s => s.nickname);

    io.to(currentRoom).emit('participantsUpdate', {
      names: roomData.participants,
      roles: roomData.roles,
      avatars: roomData.avatars,
      moods: roomData.moods,
      connected: stillConnected,
      devices: roomData.devices
    });

    io.to(currentRoom).emit('userLeft', targetNickname);
    console.log(`✅ ${targetNickname} removed by Scrum Master`);
  });

  //
  // ─── END POINTING SESSION (SCRUM MASTER) ────────────────────────────────────────
  //
  socket.on('endPointingSession', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    io.to(currentRoom).emit('sessionTerminated');
    delete rooms[currentRoom];
  });

  //
  // ─── START SESSION ─────────────────────────────────────────────────────────────
  //
  socket.on('startSession', ({ title, room }) => {
    if (!rooms[room]) return;
    rooms[room].votes = {};
    rooms[room].participants.forEach(p => rooms[room].votes[p] = null);
    rooms[room].currentStory = title;
    io.to(room).emit('startSession', title);
  });

  //
  // ─── TEAM CHAT ─────────────────────────────────────────────────────────────────
  //
  socket.on('teamChat', ({ sender, text }) => {
    if (currentRoom && text) {
      io.to(currentRoom).emit('teamChat', { sender, text });
    }
  });

  //
  // ─── EMOJI REACTION ────────────────────────────────────────────────────────────
  //
  socket.on('emojiReaction', ({ sender, emoji }) => {
    if (currentRoom) {
      io.to(currentRoom).emit('emojiReaction', { sender, emoji });
    }
  });

  //
  // ─── USER TYPING ───────────────────────────────────────────────────────────────
  //
  socket.on('userTyping', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const roomData = rooms[currentRoom];
    if (!roomData.typing.includes(nickname)) roomData.typing.push(nickname);
    io.to(currentRoom).emit('typingUpdate', roomData.typing);
    setTimeout(() => {
      roomData.typing = roomData.typing.filter(name => name !== nickname);
      io.to(currentRoom).emit('typingUpdate', roomData.typing);
    }, 3000);
  });

  //
  // ─── UPDATE MOOD ───────────────────────────────────────────────────────────────
  //
  socket.on('updateMood', ({ nickname: name, emoji }) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    rooms[currentRoom].moods[name] = emoji;
    const connectedNow = [...io.sockets.sockets.values()]
      .filter(s => s.rooms.has(currentRoom))
      .map(s => s.nickname);

    io.to(currentRoom).emit('participantsUpdate', {
      names: rooms[currentRoom].participants,
      roles: rooms[currentRoom].roles,
      avatars: rooms[currentRoom].avatars,
      moods: rooms[currentRoom].moods,
      connected: connectedNow,
      devices: rooms[currentRoom].devices
    });
  });

  //
  // ─── LOGOUT HANDLER ────────────────────────────────────────────────────────────
  //
  socket.on('logout', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const r = rooms[currentRoom];

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
      connected: [...io.sockets.sockets.values()]
        .filter(s => s.rooms.has(currentRoom))
        .map(s => s.nickname),
      devices: r.devices
    });

    socket.to(currentRoom).emit('userLeft', nickname);
    socket.leave(currentRoom);
    console.log(`${nickname} logged out manually.`);

    if (r.participants.length === 0) {
      delete rooms[currentRoom];
    }
  });

  //
  // ─── DISCONNECT HANDLER ───────────────────────────────────────────────────────
  //
  socket.on('disconnect', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const r = rooms[currentRoom];

    // Immediately broadcast updated “connected” list
    const connectedNow = [...io.sockets.sockets.values()]
      .filter(s => s.rooms.has(currentRoom))
      .map(s => s.nickname);

    io.to(currentRoom).emit('participantsUpdate', {
      names: r.participants,
      roles: r.roles,
      avatars: r.avatars,
      moods: r.moods,
      connected: connectedNow,
      devices: r.devices
    });

    console.log(`${nickname} disconnected but remains in participants until logout.`);
  });

  //
  // ─── H A I F E T T I  (broadcast confetti trigger) ──────────────────────────
  //
  socket.on('haifetti', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    io.to(currentRoom).emit('haifetti');
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`✅ Scrum Pointing server running on port ${PORT}`));