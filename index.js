const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(cors());

const sessions = {};

io.on('connection', (socket) => {
  socket.on('join', ({ nickname, room }) => {
    socket.join(room);
    socket.data.nickname = nickname;
    socket.data.room = room;

    if (!sessions[room]) {
      sessions[room] = {
        participants: new Set(),
        votes: {},
        scrumMaster: nickname.toLowerCase().includes('scrum') ? nickname : null,
        sessionActive: false,
        storyTitle: ''
      };
    }

    sessions[room].participants.add(nickname);
    io.to(room).emit('participantsUpdate', Array.from(sessions[room].participants));
  });

  socket.on('disconnect', () => {
    const room = socket.data.room;
    const nickname = socket.data.nickname;
    if (room && sessions[room]) {
      sessions[room].participants.delete(nickname);
      delete sessions[room].votes[nickname];
      io.to(room).emit('participantsUpdate', Array.from(sessions[room].participants));
      io.to(room).emit('updateVotes', sessions[room].votes);
    }
  });

  socket.on('startSession', ({ title, room }) => {
    const session = sessions[room];
    if (session) {
      session.storyTitle = title;
      session.votes = {};
      session.sessionActive = true;
      io.to(room).emit('startSession', title);
      io.to(room).emit('updateVotes', session.votes);
    }
  });

  socket.on('vote', ({ nickname, point }) => {
    const room = socket.data.room;
    const session = sessions[room];
    if (session) {
      session.votes[nickname] = point;
      io.to(room).emit('updateVotes', session.votes);
    }
  });

  socket.on('revealVotes', () => {
    const room = socket.data.room;
    if (sessions[room]) {
      io.to(room).emit('revealVotes');
    }
  });

  socket.on('endSession', () => {
    const room = socket.data.room;
    const session = sessions[room];
    if (session) {
      session.sessionActive = false;
      session.storyTitle = '';
      session.votes = {};
      io.to(room).emit('sessionEnded');
    }
  });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
