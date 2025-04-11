// Updated backend with support for team chat
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

const sessions = {}; // room => { votes, storyTitle, sessionActive, roles, avatars, participants }

io.on('connection', (socket) => {
  let userRoom = '';
  let userName = '';

  socket.on('join', ({ nickname, room, role, avatar }) => {
    userRoom = room;
    userName = nickname;
    socket.join(room);

    if (!sessions[room]) {
      sessions[room] = {
        votes: {},
        storyTitle: '',
        sessionActive: false,
        roles: {},
        avatars: {},
        participants: new Set()
      };
    }

    sessions[room].participants.add(nickname);
    sessions[room].roles[nickname] = role;
    sessions[room].avatars[nickname] = avatar;

    io.to(room).emit('participantsUpdate', {
      names: Array.from(sessions[room].participants),
      roles: sessions[room].roles,
      avatars: sessions[room].avatars
    });

    io.to(room).emit('userJoined', nickname);
  });

  socket.on('vote', ({ nickname, point }) => {
    if (sessions[userRoom]) {
      sessions[userRoom].votes[nickname] = point;
      io.to(userRoom).emit('updateVotes', sessions[userRoom].votes);
    }
  });

  socket.on('startSession', ({ title, room }) => {
    if (sessions[room]) {
      sessions[room].storyTitle = title;
      sessions[room].votes = {};
      sessions[room].sessionActive = true;
      io.to(room).emit('startSession', title);
      io.to(room).emit('updateVotes', {});
    }
  });

  socket.on('revealVotes', () => {
    io.to(userRoom).emit('revealVotes');
  });

  socket.on('endSession', () => {
    if (sessions[userRoom]) {
      sessions[userRoom].sessionActive = false;
      sessions[userRoom].votes = {};
      io.to(userRoom).emit('sessionEnded');
    }
  });

  socket.on('teamChat', ({ room, sender, text }) => {
    io.to(room).emit('teamChat', { sender, text });
  });

  socket.on('disconnect', () => {
    if (userRoom && sessions[userRoom]) {
      sessions[userRoom].participants.delete(userName);
      delete sessions[userRoom].roles[userName];
      delete sessions[userRoom].avatars[userName];
      delete sessions[userRoom].votes[userName];

      io.to(userRoom).emit('participantsUpdate', {
        names: Array.from(sessions[userRoom].participants),
        roles: sessions[userRoom].roles,
        avatars: sessions[userRoom].avatars
      });

      io.to(userRoom).emit('userLeft', userName);
    }
  });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));