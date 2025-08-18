import { Socket } from "socket.io-client";
import { Message, RTCConnection } from "./types";
import { onewaySync, throwIfUndefined, timer } from "./util";
import React, { RefObject } from "react";

export const rtcConnections = new Map<string, RTCConnection>();
const configuration = {
  // iceServers: [
  //   {
  //     urls: ["stun:stun1.l.google.com:19302", "stun:stun2.l.google.com:19302"],
  //   },
  // ],
  iceCandidatePoolSize: 10,
};

export async function makeCall(invitation, socketInstance: Socket, oneWayOffsets: RefObject<number[]>, setOneWayOffsetAverage: (average: number) => void) {
      // console.log("makeCall");
      try {
        let pc = new RTCPeerConnection(configuration);
        let dc = pc.createDataChannel("rtc-data-channel", { negotiated: true, id: 0 });
        let connection: RTCConnection = { pc, dc };
        let targetId = invitation.senderId;
        rtcConnections.set(targetId, connection);

        dc.onopen = async (event) => {
          // console.log("Data Channel Open!");
          // sendMessage(connection, { command: "talk", value: "Hi you!" });

          // Sleep to avoid sending message before peer's data channel is ready
          await timer(500);
          onewaySync(targetId, connection, socketInstance).then((oneWayOffset) => {
            if (oneWayOffset !== undefined) {
              oneWayOffsets.current.push(oneWayOffset);
              setOneWayOffsetAverage(oneWayOffsets.current.reduce((a, b) => a + b) / oneWayOffsets.current.length);
              // console.log("One Way Offsets: ", oneWayOffsets.current);
            }
            // socketInstance.emit("rtc-message", { type: "bye", targetId: targetId, senderId: socketInstance.id });
          }).catch((error) => {
            console.error("Synchronization error: ", error);
          });
        };

        pc.onicecandidate = (e) => {
          throwIfUndefined(socketInstance.id);
          const message: Message = {
            type: "candidate",
            targetId: targetId,
            senderId: socketInstance.id,
            candidate: null,
          };
          if (e.candidate) {
            message.candidate = e.candidate.candidate;
            message.sdpMid = e.candidate.sdpMid;
            message.sdpMLineIndex = e.candidate.sdpMLineIndex;
          }
          socketInstance.emit("rtc-message", message);
        };

        dc.onmessage = (event) => {
          const message = JSON.parse(event.data).message;
          if (message.command === "calculate-latency-client-1") {
            // console.log("Recieved Latency Message: ", event.data);
            const senderId = message.senderId;
            socketInstance.volatile.emit("calculate-latency-client-2", senderId);
          }
        };

        dc.onclose = (event) => {
          // console.log("Data Channel Closed!!");
        };

        const offer = await pc.createOffer();
        socketInstance.emit("rtc-message", { type: "offer", sdp: offer.sdp, targetId: invitation.senderId, senderId: socketInstance.id });
        await pc.setLocalDescription(offer);
      } catch (e) {
        console.log(e);
      }
    }

    export async function handleOffer(offer, socketInstance: Socket, oneWayOffsets: RefObject<number[]>, setOneWayOffsetAverage: (average: number) => void) {
      // console.log("handle offer: ", offer);
      try {
        let pc = new RTCPeerConnection(configuration);
        let dc = pc.createDataChannel("rtc-data-channel", { negotiated: true, id: 0 });
        let connection = { pc, dc };
        let targetId = offer.senderId;
        rtcConnections.set(targetId, connection);

        dc.onopen = async (event) => {
          // console.log("Data Channel Open!");
          // sendMessage(connection, { command: "talk", value: "Hi you!" });
          // Sleep to avoid sending message before peer's data channel is ready
          await timer(1000);
          onewaySync(targetId, connection, socketInstance).then((oneWayOffset) => {
            if (oneWayOffset) {
              oneWayOffsets.current.push(oneWayOffset);
              setOneWayOffsetAverage(oneWayOffsets.current.reduce((a, b) => a + b) / oneWayOffsets.current.length);
              // console.log("One Way Offsets: ", oneWayOffsets.current);
            }
            // socketInstance.emit("rtc-message", { type: "bye", targetId: targetId, senderId: socketInstance.id });
          }).catch((error) => {
            console.error("Synchronization error: ", error);
          });
        };

        pc.onicecandidate = (e) => {
          throwIfUndefined(socketInstance.id);
          const message: Message = {
            type: "candidate",
            targetId: targetId,
            senderId: socketInstance.id,
            candidate: null
          };
          if (e.candidate) {
            message.candidate = e.candidate.candidate;
            message.sdpMid = e.candidate.sdpMid;
            message.sdpMLineIndex = e.candidate.sdpMLineIndex;
          }
          socketInstance.emit("rtc-message", message);
        };

        dc.onmessage = (event) => {
          const message = JSON.parse(event.data).message;
          if (message.command === "calculate-latency-client-1") {
            // console.log("Recieved Latency Message: ", event.data);
            const senderId = message.senderId;
            socketInstance.volatile.emit("calculate-latency-client-2", senderId);
          }
        };

        dc.onclose = (event) => {
          console.log("Data Channel Closed!!");
        };

        await pc.setRemoteDescription({ type: offer.type, sdp: offer.sdp });
        const answer = await pc.createAnswer();
        socketInstance.emit("rtc-message", { type: "answer", sdp: answer.sdp, targetId: offer.senderId, senderId: socketInstance.id });
        // setRtcSocketId(offer.callerId);
        await pc.setLocalDescription(answer);
      } catch (e) {
        console.log(e);
      }
    }


     export async function handleAnswer(answer) {
        // console.log("handle answer: ", answer);
        let rtcConnection = rtcConnections.get(answer.senderId);
        try {
          if (rtcConnection) {
            await rtcConnection.pc.setRemoteDescription({ type: answer.type, sdp: answer.sdp });
          }
        } catch (e) {
          console.log(e);
        }
      }
    
     export async function handleCandidate(candidate) {
        // console.log("handle candidate: ", candidate);
        let rtcConnection = rtcConnections.get(candidate.senderId);
        try {
          if (!rtcConnection) {
            console.error("no peerconnection");
            return;
          }
          if (!candidate) {
            await rtcConnection.pc.addIceCandidate(null);
          } else {
            await rtcConnection.pc.addIceCandidate(candidate);
          }
        } catch (e) {
          if (e instanceof TypeError === false) {
            console.log(e);
          }
        }
      }
    
     export async function hangup(disinvitation) {
        // console.log("hangup: ", disinvitation);
        let rtcConnection = rtcConnections.get(disinvitation.senderId);
        if (rtcConnection) {
          rtcConnection.pc.close();
          rtcConnections.delete(disinvitation.senderId);
        }
      }