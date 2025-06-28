import http from "http";
import express from "express";
const app = express()
const server = http.createServer(app);
import { Server } from "socket.io";
export const io = new Server(server, { pingInterval: 10000 });
import path from "path";
const port = 3000
import os from "os";
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import Orchestra from "./orchestra.js";
import conductorHandlers from "./conductor.ts";
import performerHandlers from "./performer.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

app.use(express.static(path.join(__dirname, '../../Performer/build')));
app.use('/conductor', express.static(path.join(__dirname, '../../Conductor/build')));


// let baselineDate = new Date();
export const orc = new Orchestra();

var networkInterfaces = os.networkInterfaces();
export const ipAddress = Object.values(networkInterfaces).reduce((r: any, list: any) => r.concat(list.reduce((rr: any, i: any) => rr.concat(i.family === 'IPv4' && !i.internal && i.address || []), [])), [])[0];

// Namespaces
var performers = io.of('/');
var conductors = io.of('/conductor');

conductorHandlers(conductors, performers);
performerHandlers(performers, conductors);

server.listen(port, () => {
  console.log('listening on *:3000');
  if (ipAddress) {
    console.log("Connect to Metronome here: http://" + ipAddress + ":3000");
  } else {
    console.log("ERROR: NO NETWORK CONNECTION FOUND")
  }
});