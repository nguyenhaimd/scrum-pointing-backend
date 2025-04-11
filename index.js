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

const rooms = {}; // { roomName: [user1, user2, ...] }
const userRoles = {};
const userAvatars = {};
const votes = {};
const sessions = {};

io.on('connection', (socket) => {
  socket.on('join', ({ nickname, room, role, avatar }) => {
    socket.join(room);
    if (!rooms[room]) rooms[room] = [];
    if (!rooms[room].includes(nickname)) rooms[room].push(nickname);
    userRoles[nickname] = role;
    userAvatars[nickname] = avatar;
    votes[nickname] = null;

    io.to(room).emit('participantsUpdate', {
      names: rooms[room],
      roles: userRoles,
      avatars: userAvatars
    });

    io.to(room).emit('userJoined', nickname);
  });

  socket.on('vote', ({ nickname, point }) => {
    votes[nickname] = point;
    const userRoom = getUserRoom(nickname);
    if (userRoom) {
      io.to(userRoom).emit('updateVotes', votes);
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
    const userRoom = getSocketRoom(socket);
    if (userRoom) {
      io.to(userRoom).emit('revealVotes');
    }
  });

  socket.on('endSession', () => {
    const userRoom = getSocketRoom(socket);
    if (userRoom) {
      io.to(userRoom).emit('sessionEnded');
    }
  });

  socket.on('teamChat', ({ room, sender, text }) => {
    io.to(room).emit('teamChat', { sender, text });
  });

  socket.on('emojiReaction', ({ sender, emoji }) => {
    const room = getUserRoom(sender);
    if (room) {
      io.to(room).emit('emojiReaction', { sender, emoji });
    }
  });

  socket.on('disconnect', () => {
    const nickname = Object.keys(userRoles).find(name => socket.rooms.has(getUserRoom(name)));
    const room = getUserRoom(nickname);
    if (nickname && room && rooms[room]) {
      rooms[room] = rooms[room].filter(name => name !== nickname);
      delete userRoles[nickname];
      delete userAvatars[nickname];
      delete votes[nickname];

      io.to(room).emit('participantsUpdate', {
        names: rooms[room],
        roles: userRoles,
        avatars: userAvatars
      });

      io.to(room).emit('userLeft', nickname);
    }
  });
});

function getUserRoom(nickname) {
  for (const room in rooms) {
    if (rooms[room].includes(nickname)) return room;
  }
  return null;
}

function getSocketRoom(socket) {
  const joinedRooms = Array.from(socket.rooms).filter(r => r !== socket.id);
  return joinedRooms[0] || null;
}

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});