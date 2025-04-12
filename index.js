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
  },
});

const rooms = {}; // { roomName: { participants: {}, story: '', votes: {}, revealed: false } }

io.on('connection', (socket) => {
  console.log('🟢 A user connected');

  socket.on('join', ({ nickname, room, role, avatar, emoji }) => {
    socket.join(room);
    socket.data = { nickname, room, role };

    if (!rooms[room]) {
      rooms[room] = {
        participants: {},
        votes: {},
        revealed: false,
        story: '',
        avatars: {},
        moods: {},
      };
    }

    rooms[room].participants[nickname] = role;
    rooms[room].avatars[nickname] = avatar;
    rooms[room].moods[nickname] = emoji || '😎';
    rooms[room].votes[nickname] = null;

    io.to(room).emit('participantsUpdate', {
      names: Object.keys(rooms[room].participants),
      roles: rooms[room].participants,
      avatars: rooms[room].avatars,
      moods: rooms[room].moods,
    });

    socket.to(room).emit('userJoined', nickname);
  });

  socket.on('updateMood', ({ nickname, emoji }) => {
    const room = socket.data.room;
    if (rooms[room] && rooms[room].moods[nickname]) {
      rooms[room].moods[nickname] = emoji;
      io.to(room).emit('participantsUpdate', {
        names: Object.keys(rooms[room].participants),
        roles: rooms[room].participants,
        avatars: rooms[room].avatars,
        moods: rooms[room].moods,
      });
    }
  });

  socket.on('vote', ({ nickname, point }) => {
    const room = socket.data.room;
    if (rooms[room]) {
      rooms[room].votes[nickname] = point;
      io.to(room).emit('updateVotes', rooms[room].votes);
    }
  });

  socket.on('startSession', ({ title, room }) => {
    if (rooms[room]) {
      rooms[room].story = title;
      rooms[room].votes = {};
      Object.keys(rooms[room].participants).forEach((name) => {
        rooms[room].votes[name] = null;
      });
      rooms[room].revealed = false;
      io.to(room).emit('startSession', title);
      io.to(room).emit('updateVotes', rooms[room].votes);
    }
  });

  socket.on('revealVotes', () => {
    const room = socket.data.room;
    if (rooms[room]) {
      rooms[room].revealed = true;
      io.to(room).emit('revealVotes');
    }
  });

  socket.on('endSession', () => {
    const room = socket.data.room;
    if (rooms[room]) {
      rooms[room].revealed = false;
      rooms[room].votes = {};
      rooms[room].story = '';
      io.to(room).emit('sessionEnded');
    }
  });
  socket.on('emojiReaction', ({ sender, emoji }) => {
    const room = socket.data.room;
    if (room) {
      io.to(room).emit('emojiReaction', { sender, emoji });
    }
  });

  socket.on('teamChat', ({ sender, text }) => {
    const room = socket.data.room;
    if (room) {
      io.to(room).emit('teamChat', { sender, text });
    }
  });

  socket.on('userTyping', () => {
    const room = socket.data.room;
    if (!room) return;

    const typingSet = rooms[room].typing || new Set();
    typingSet.add(socket.data.nickname);
    rooms[room].typing = typingSet;

    io.to(room).emit('typingUpdate', Array.from(typingSet));

    setTimeout(() => {
      if (rooms[room] && rooms[room].typing) {
        rooms[room].typing.delete(socket.data.nickname);
        io.to(room).emit('typingUpdate', Array.from(rooms[room].typing));
      }
    }, 3000);
  });

  socket.on('disconnect', () => {
    const { room, nickname } = socket.data;
    if (room && rooms[room]) {
      delete rooms[room].participants[nickname];
      delete rooms[room].avatars[nickname];
      delete rooms[room].moods[nickname];
      delete rooms[room].votes[nickname];
      if (rooms[room].typing) {
        rooms[room].typing.delete(nickname);
      }

      io.to(room).emit('participantsUpdate', {
        names: Object.keys(rooms[room].participants),
        roles: rooms[room].participants,
        avatars: rooms[room].avatars,
        moods: rooms[room].moods,
      });

      io.to(room).emit('userLeft', nickname);

      // clean up empty rooms
      if (Object.keys(rooms[room].participants).length === 0) {
        delete rooms[room];
      }
    }

    console.log('🔴 A user disconnected');
  });
});

server.listen(10000, () => {
  console.log('✅ Server is running on http://localhost:10000');
});
