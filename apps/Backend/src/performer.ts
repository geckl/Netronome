import { Namespace, Socket } from "socket.io";
import { Performer } from "./types.js";
import { UUID } from "crypto";
import { orc} from "./server.ts"

const members: Performer[] = [];
let membersCounter = 0;

const performerRoutes = (performers: Namespace, conductors: Namespace) => {

// Performer Socket
performers.on('connection', (socket: Socket) => {
    console.log('a user connected');
  
    let uuid: UUID = crypto.randomUUID();
    const performer: Performer = { id: uuid, name: `Performer #${membersCounter + 1}`, status: "Disconnected", latencies: [] }
    members.push(performer);
    membersCounter++;
    conductors.emit("update-members", members);
    console.log("user connected: ", performer);
    // socket.emit("starttime", baselineDate);
  
    socket.on("request-join", () => {
      performer.status = "Connecting";
      conductors.emit("update-members", members);
    });
  
    socket.on("calculate-latency", (time: number, cb: (latency: number) => void) => {
      const latencyPlusOffset = performance.now() - time;
      //const latencyPlusOffset = Date.now() - time;
      cb(latencyPlusOffset);
    });
  
    // socket.conn.on("heartbeat", () => {
    //   // called after each round trip of the heartbeat mechanism
    //   console.log("heartbeat");
    // });
  
    socket.on("join-orchestra", (latencies: number[]) => {
      performer.latencies = latencies;
      performer.status = "Connected"
      orc.addPerformer(performer);
      conductors.emit("update-members", members);
      console.log("user joined orchestra: ", performer);
    });
  
    socket.on("leave-orchestra", () => {
      if (performer.status === "Connected") {
        orc.removePerformer(performer);
      }
      performer.status = "Disconnected"
      conductors.emit("update-members", members);
      console.log("user left orchestra: ", performer);
    });
  
    socket.on('connect_error', (err) => {
      console.log(err.message);
    });
  
    socket.on('disconnect', () => {
      if (performer.status === "Connected") {
        orc.removePerformer(performer);
      }
      let performerIndex = members.map(c => c.id).indexOf(performer.id)
      members.splice(performerIndex, 1);
      conductors.emit("update-members", members);
      console.log("user disconnected: ", members);
    });
  
    setInterval(() => {
      if (orc.isPlaying) {
        const start = performance.now();
        socket.emit("ping", () => {
          // Normally this number would be divided by two to get one-way latency, but leaving doubled to account for changing latencies
          const latency = (performance.now() - start) / 2;
          performer.latencies.push(latency);
          performer.latencies.shift();
          console.log(performer.name, " LATENCY: ", performer.latencies);
        });
        // conductors.emit("update-members", memebers);
      }
    }, 10000);
  });
}

export default performerRoutes;