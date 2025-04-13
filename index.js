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
    methods: ['GET', 'POST'],
  }
});

const rooms = {}; // Stores all room data

io.on('connection', (socket) => {
  let currentRoom = null;
  let nickname = null;

  socket.on('join', ({ nickname: name, room, role, avatar, emoji }) => {
    nickname = name;
    currentRoom = room;
    socket.join(room);

    if (!rooms[room]) {
      rooms[room] = {
        participants: [],
        roles: {},
        avatars: {},
        moods: {},
        votes: {},
        typing: [],
      };
    }

    const r = rooms[room];
    if (!r.participants.includes(nickname)) r.participants.push(nickname);
    r.roles[nickname] = role;
    r.avatars[nickname] = avatar;
    r.moods[nickname] = emoji;
    r.votes[nickname] = null;

    io.to(room).emit('participantsUpdate', {
      names: r.participants,
      roles: r.roles,
      avatars: r.avatars,
      moods: r.moods,
    });

    socket.to(room).emit('userJoined', nickname);
  });

  socket.on('vote', ({ nickname: name, point }) => {
    const r = rooms[currentRoom];
    if (r) {
      r.votes[name] = point;
      io.to(currentRoom).emit('updateVotes', r.votes);
    }
  });

  socket.on('revealVotes', () => {
    if (!rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    const votes = room.votes;
    const story = room.story || 'Untitled Story';
  
    io.to(currentRoom).emit('revealVotes', { story, votes });
  });

  socket.on('endSession', () => {
    const r = rooms[currentRoom];
    if (r) {
      r.votes = {};
      r.currentStory = null;
      io.to(currentRoom).emit('sessionEnded');
    }
  });

  socket.on('startSession', ({ title, room }) => {
    const r = rooms[room];
    if (r) {
      r.votes = {};
      r.currentStory = title;
      r.participants.forEach(p => {
        r.votes[p] = null;
      });
      io.to(room).emit('startSession', title);
    }
  });

  socket.on('teamChat', ({ sender, text }) => {
    if (currentRoom) {
      io.to(currentRoom).emit('teamChat', { sender, text });
    }
  });

  socket.on('emojiReaction', ({ sender, emoji }) => {
    if (currentRoom) {
      io.to(currentRoom).emit('emojiReaction', { sender, emoji });
    }
  });

  socket.on('userTyping', () => {
    const r = rooms[currentRoom];
    if (r && !r.typing.includes(nickname)) {
      r.typing.push(nickname);
      io.to(currentRoom).emit('typingUpdate', r.typing);
      setTimeout(() => {
        r.typing = r.typing.filter(n => n !== nickname);
        io.to(currentRoom).emit('typingUpdate', r.typing);
      }, 3000);
    }
  });

  socket.on('updateMood', ({ nickname: name, emoji }) => {
    const r = rooms[currentRoom];
    if (r) {
      r.moods[name] = emoji;
      io.to(currentRoom).emit('participantsUpdate', {
        names: r.participants,
        roles: r.roles,
        avatars: r.avatars,
        moods: r.moods,
      });
    }
  });

  socket.on('disconnect', () => {
    const r = rooms[currentRoom];
    if (r) {
      r.participants = r.participants.filter(p => p !== nickname);
      delete r.roles[nickname];
      delete r.avatars[nickname];
      delete r.moods[nickname];
      delete r.votes[nickname];

      io.to(currentRoom).emit('participantsUpdate', {
        names: r.participants,
        roles: r.roles,
        avatars: r.avatars,
        moods: r.moods,
      });

      socket.to(currentRoom).emit('userLeft', nickname);

      if (r.participants.length === 0) {
        delete rooms[currentRoom];
      }
    }
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`✅ Scrum Pointing backend running on port ${PORT}`);
});