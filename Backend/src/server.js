var http = require('http');
const express = require('express')
const app = express()
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server, {pingInterval: 5000});
var path = require('path');
const port = 3000
var os = require('os');

app.use(express.static(path.join(__dirname, '../../Performer/build')));
app.use('/conductor',express.static(path.join(__dirname, '../../Conductor/build')));

// app.get('*', (req, res) => {
//     res.sendFile(path.join(__dirname, '../../Performer/build', "index.html"));
// });

// app.get('conductor/*', (req, res) => {
//     res.sendFile(path.join(__dirname, '../../Conductor/build', "index.html"));
// });

io.on('connection', (socket) => {
console.log('a user connected');

socket.emit("starttime", 0 );

socket.on('conductor-start', (msg) => {
    console.log('conductor-start');
    socket.broadcast.emit('start')
  });

socket.on('connect_error', (err) => {
    console.log(err.message);
})

socket.on('disconnect', () => {
    console.log('user disconnected');
    });
});
  
server.listen(3000, () => {
console.log('listening on *:3000');
var networkInterfaces = os.networkInterfaces();
console.log("Connect to Metronome here: http://" + networkInterfaces['en0'][0].address + ":3000");
});