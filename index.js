const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const rooms = {};
const userRoles = {};
const userAvatars = {};
const votes = {};
const sessions = {};
const emojiCounts = {};
const typingUsers = {};

io.on('connection', (socket) => {
  socket.on('connect', () => {
    socket.emit('connectionStatus', 'connected');
  });

  socket.on('join', ({ nickname, room, role, avatar }) => {
    socket.join(room);
    socket.nickname = nickname;
    socket.room = room;

    if (!rooms[room]) rooms[room] = [];
    if (!rooms[room].includes(nickname)) rooms[room].push(nickname);
    userRoles[nickname] = role;
    userAvatars[nickname] = avatar;
    votes[nickname] = null;
    if (!emojiCounts[room]) emojiCounts[room] = {};
    if (!typingUsers[room]) typingUsers[room] = new Set();

    io.to(room).emit('participantsUpdate', {
      names: rooms[room],
      roles: userRoles,
      avatars: userAvatars
    });

    io.to(room).emit('userJoined', nickname);
  });

  socket.on('vote', ({ nickname, point }) => {
    votes[nickname] = point;
    const room = socket.room;
    if (room) {
      io.to(room).emit('updateVotes', votes);
    }
  });

  socket.on('startSession', ({ title, room }) => {
    sessions[room] = { title, votes: {} };
    for (const name of rooms[room]) {
      votes[name] = null;
    }
    io.to(room).emit('startSession', title);
  });

  socket.on('revealVotes', () => {
    const room = socket.room;
    if (room) {
      io.to(room).emit('revealVotes');
    }
  });

  socket.on('endSession', () => {
    const room = socket.room;
    if (room) {
      io.to(room).emit('sessionEnded');
    }
  });

  socket.on('teamChat', ({ room, sender, text }) => {
    io.to(room).emit('teamChat', { sender, text });
  });

  socket.on('emojiReaction', ({ sender, emoji }) => {
    const room = socket.room;
    if (!room) return;

    emojiCounts[room][emoji] = (emojiCounts[room][emoji] || 0) + 1;

    io.to(room).emit('emojiReaction', { sender, emoji });
    io.to(room).emit('emojiSummary', emojiCounts[room]);
  });

  socket.on('userTyping', () => {
    const { nickname, room } = socket;
    if (!room || !nickname) return;
    typingUsers[room].add(nickname);
    io.to(room).emit('typingUpdate', Array.from(typingUsers[room]));

    setTimeout(() => {
      typingUsers[room].delete(nickname);
      io.to(room).emit('typingUpdate', Array.from(typingUsers[room]));
    }, 3000);
  });

  socket.on('disconnecting', () => {
    socket.emit('connectionStatus', 'disconnected');
  });

  socket.on('disconnect', () => {
    const { nickname, room } = socket;
    if (!nickname || !room || !rooms[room]) return;

    rooms[room] = rooms[room].filter((name) => name !== nickname);
    delete userRoles[nickname];
    delete userAvatars[nickname];
    delete votes[nickname];

    if (typingUsers[room]) {
      typingUsers[room].delete(nickname);
      io.to(room).emit('typingUpdate', Array.from(typingUsers[room]));
    }

    io.to(room).emit('participantsUpdate', {
      names: rooms[room],
      roles: userRoles,
      avatars: userAvatars
    });

    io.to(room).emit('userLeft', nickname);
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});