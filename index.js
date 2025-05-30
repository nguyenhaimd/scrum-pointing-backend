// ✅ FINAL Full Backend index.js for Scrum Pointing App
// Includes: reconnection grace period, role/avatar-independent rejoin, connection status tracking, device type detection

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

const GRACE_PERIOD_MS = 20 * 60 * 1000; // 20 minutes
const rooms = {}; // roomName: { participants, roles, avatars, moods, votes, typing, currentStory, disconnectTimers, devices }

io.on('connection', (socket) => {
  let currentRoom = null;
  let nickname = null;
  const userAgent = socket.handshake.headers['user-agent'] || '';
  const isMobile = /mobile/i.test(userAgent);

  socket.on('join', ({ nickname: name, room, role, avatar, emoji }) => {
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
        disconnectTimers: {},
        devices: {}
      };
    }

    const r = rooms[room];

    if (!r.participants.includes(nickname)) {
      r.participants.push(nickname);
    } else if (r.disconnectTimers[nickname]) {
      clearTimeout(r.disconnectTimers[nickname]);
      delete r.disconnectTimers[nickname];
    }

    r.roles[nickname] = role;
    r.avatars[nickname] = avatar;
    r.moods[nickname] = emoji;
    r.votes[nickname] = null;
    r.devices[nickname] = isMobile ? 'mobile' : 'desktop';

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

  socket.on('vote', ({ nickname: name, point }) => {
    if (rooms[currentRoom]) {
      rooms[currentRoom].votes[name] = point;
      io.to(currentRoom).emit('updateVotes', rooms[currentRoom].votes);
    }
  });

  socket.on('revealVotes', () => {
    if (!rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    const votes = room.votes || {};
    const freq = {};

    const connectedDevelopers = [...io.sockets.sockets.values()]
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

    const max = Math.max(...Object.values(freq), 0);
    const consensus = Object.keys(freq)
      .filter(k => freq[k] === max)
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

    const scrumMasters = room.participants.filter(p => room.roles[p] === 'Scrum Master');
    for (const smName of scrumMasters) {
      const smSocket = [...io.sockets.sockets.values()].find(
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
    const room = rooms[currentRoom];
    const senderRole = room.roles[nickname];
    if (senderRole !== 'Scrum Master') return;
    if (!room.participants.includes(targetNickname)) return;

    const isStillConnected = [...io.sockets.sockets.values()]
      .some(s => s.rooms.has(currentRoom) && s.nickname === targetNickname);

    if (isStillConnected) {
      console.log(`🚫 Attempted to remove online user: ${targetNickname}`);
      return;
    }

    room.participants = room.participants.filter(p => p !== targetNickname);
    delete room.roles[targetNickname];
    delete room.avatars[targetNickname];
    delete room.moods[targetNickname];
    delete room.votes[targetNickname];
    delete room.devices[targetNickname];

    io.to(currentRoom).emit('participantsUpdate', {
      names: room.participants,
      roles: room.roles,
      avatars: room.avatars,
      moods: room.moods,
      connected: [...io.sockets.sockets.values()]
        .filter(s => s.rooms.has(currentRoom))
        .map(s => s.nickname),
      devices: room.devices
    });

    io.to(currentRoom).emit('userLeft', targetNickname);
    console.log(`✅ ${targetNickname} removed by Scrum Master`);
  });

  socket.on('endPointingSession', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    io.to(currentRoom).emit('sessionTerminated');
    delete rooms[currentRoom];
  });

  socket.on('startSession', ({ title, room }) => {
    if (rooms[room]) {
      rooms[room].votes = {};
      rooms[room].participants.forEach(p => rooms[room].votes[p] = null);
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
    const room = rooms[currentRoom];
    if (!room.typing.includes(nickname)) room.typing.push(nickname);
    io.to(currentRoom).emit('typingUpdate', room.typing);
    setTimeout(() => {
      room.typing = room.typing.filter(name => name !== nickname);
      io.to(currentRoom).emit('typingUpdate', room.typing);
    }, 3000);
  });

  socket.on('updateMood', ({ nickname: name, emoji }) => {
    if (rooms[currentRoom]) {
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
    }
  });

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
      names: r.participants,
      roles: r.roles,
      avatars: r.avatars,
      moods: r.moods,
      devices: r.devices
    });
    socket.to(currentRoom).emit('userLeft', nickname);
    socket.leave(currentRoom);
    console.log(`${nickname} logged out manually.`);
    if (r.participants.length === 0) delete rooms[currentRoom];
  });

  socket.on('disconnect', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const r = rooms[currentRoom];
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
    console.log(`${nickname} disconnected but will remain until logout.`);
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`✅ Scrum Pointing server running on port ${PORT}`));
