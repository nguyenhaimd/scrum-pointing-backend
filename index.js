// ✅ FINAL Full Backend index.js for Scrum Pointing App
// Includes: reconnection grace period, role/avatar-independent rejoin, connection status tracking

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
const rooms = {}; // roomName: { participants, roles, avatars, moods, votes, typing, currentStory, disconnectTimers }

io.on('connection', (socket) => {
  let currentRoom = null;
  let nickname = null;

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

    r.roles[nickname] = role;
    r.avatars[nickname] = avatar;
    r.moods[nickname] = emoji;
    r.votes[nickname] = null;

    const connectedNicknames = [...io.sockets.sockets.values()]
      .filter(s => s.rooms.has(room))
      .map(s => s.nickname);

    io.to(room).emit('participantsUpdate', {
      names: r.participants,
      roles: r.roles,
      avatars: r.avatars,
      moods: r.moods,
      connected: connectedNicknames
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
    const developers = room.participants.filter(p => room.roles[p] === 'Developer');
    const votes = room.votes || {};
    const freq = {};

    developers.forEach((name) => {
      const point = Number(votes[name]);
      if (!isNaN(point)) freq[point] = (freq[point] || 0) + 1;
    });

    const max = Math.max(...Object.values(freq));
    const consensus = Object.keys(freq)
      .filter(k => freq[k] === max)
      .map(Number);

    const voteList = developers.map((name) => ({
      name,
      avatar: room.avatars[name],
      point: votes[name],
    }));

    const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

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
        connected: connectedNow
      });
    }
  });

  // logout handler
  socket.on('logout', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const r = rooms[currentRoom];
  
    // Remove user fully
    r.participants = r.participants.filter(p => p !== nickname);
    delete r.votes[nickname];
    delete r.roles[nickname];
    delete r.avatars[nickname];
    delete r.moods[nickname];
  
    // Broadcast updated roster
    io.to(currentRoom).emit('participantsUpdate', {
      names:   r.participants,
      roles:   r.roles,
      avatars: r.avatars,
      moods:   r.moods,
      // you may also include connected list if you track it
    });
    socket.to(currentRoom).emit('userLeft', nickname);
  
    socket.leave(currentRoom);
    console.log(`${nickname} logged out manually.`);
  
    // Clean up empty room
    if (r.participants.length === 0) delete rooms[currentRoom];
  });  

  socket.on('disconnect', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const r = rooms[currentRoom];

    // Emit immediately who is still connected
    const connectedNow = [...io.sockets.sockets.values()]
      .filter(s => s.rooms.has(currentRoom))
      .map(s => s.nickname);

    io.to(currentRoom).emit('participantsUpdate', {
      names: r.participants,
      roles: r.roles,
      avatars: r.avatars,
      moods: r.moods,
      connected: connectedNow
    });

    {/*
    // Graceful disconnect timer
    r.disconnectTimers[nickname] = setTimeout(() => {
      r.participants = r.participants.filter(p => p !== nickname);
      delete r.votes[nickname];
      delete r.roles[nickname];
      delete r.avatars[nickname];
      delete r.moods[nickname];

      const stillConnected = [...io.sockets.sockets.values()]
        .filter(s => s.rooms.has(currentRoom))
        .map(s => s.nickname);

      io.to(currentRoom).emit('participantsUpdate', {
        names: r.participants,
        roles: r.roles,
        avatars: r.avatars,
        moods: r.moods,
        connected: stillConnected
      });

      socket.to(currentRoom).emit('userLeft', nickname);

      if (r.participants.length === 0) delete rooms[currentRoom];
    }, GRACE_PERIOD_MS);
   */}

    // Auto‑removal on disconnect disabled.
   console.log(`${nickname} disconnected but will remain until logout.`);

  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`✅ Scrum Pointing server running on port ${PORT}`));
