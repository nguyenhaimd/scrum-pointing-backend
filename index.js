// ✅ Updated backend index.js for Scrum Pointing App

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

const rooms = {}; // { roomName: { participants, votes, roles, avatars, moods, story, typing } }

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
        votes: {},
        roles: {},
        avatars: {},
        moods: {},
        typing: [],
        story: '',
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
      moods: r.moods
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
    const votes = room.votes;
    const story = room.story || 'Untitled Story';

    io.to(currentRoom).emit('revealVotes', { story, votes });
  });

  socket.on('endSession', () => {
    if (rooms[currentRoom]) {
      rooms[currentRoom].votes = {};
      rooms[currentRoom].story = '';
      io.to(currentRoom).emit('sessionEnded');
    }
  });

  socket.on('startSession', ({ title, room }) => {
    if (rooms[room]) {
      rooms[room].votes = {};
      rooms[room].story = title; // 🔥 Track current story title
      rooms[room].participants.forEach(p => rooms[room].votes[p] = null);
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
      io.to(currentRoom).emit('participantsUpdate', {
        names: rooms[currentRoom].participants,
        roles: rooms[currentRoom].roles,
        avatars: rooms[currentRoom].avatars,
        moods: rooms[currentRoom].moods,
      });
    }
  });

  socket.on('disconnect', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const r = rooms[currentRoom];
    r.participants = r.participants.filter(p => p !== nickname);
    delete r.votes[nickname];
    delete r.roles[nickname];
    delete r.avatars[nickname];
    delete r.moods[nickname];

    io.to(currentRoom).emit('participantsUpdate', {
      names: r.participants,
      roles: r.roles,
      avatars: r.avatars,
      moods: r.moods
    });
    socket.to(currentRoom).emit('userLeft', nickname);

    if (r.participants.length === 0) delete rooms[currentRoom];
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`✅ Scrum Pointing server running on port ${PORT}`));