import { DeviceType } from "./types";

// Returns a Promise that resolves after "ms" Milliseconds
export const timer = ms => new Promise(res => setTimeout(res, ms));

export const playAudio = (audioData: any) => {
    console.log(typeof audioData);
    console.log(audioData);

    const blob = new Blob([audioData], { type: "audio/mpeg" });

    
    const audioString = JSON.stringify(audioData);

    //var newData = audioString.split(";");
    //    newData[0] = "data:audio/mpeg;";
    //    newData = newData[0] + newData[1];
  
        var audio = new Audio(audioString);
        if (!audio || document.hidden) {
          return;
        }
        audio.play();
}

  export const convertTime = (destination: DeviceType, time: number, serverOffset: any) => {
    if (destination === "Server") {
      // Client time in seconds
      return (time * 1000) + serverOffset.current;
    } else if (destination === "Client") {
      //Server time in milliseconds
      return (time - serverOffset.current) / 1000;
    } else {
      throw Error(`Not a valid conversion (options are "server" or "client"`);
    }
  }

  export function throwIfUndefined<T>(x: T | undefined): asserts x is T {
    if (typeof x === "undefined") throw new Error("OH NOEZ");
}