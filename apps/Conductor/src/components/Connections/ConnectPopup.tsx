import React from "react";
import { Button, Center, Dialog, QrCode } from "@chakra-ui/react";

const ConnectPopup = ({ipAddress}: {ipAddress: string | null}) => {

    return(
        <Dialog.Root size="lg">
          <Dialog.Trigger asChild>
            <Button disabled={!ipAddress} size="sm" bg="brand.500" position={"absolute"} left={1} top={1}>
              Connect
            </Button>
          </Dialog.Trigger>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content>
              <Dialog.CloseTrigger />
              <Dialog.Header>
                <Dialog.Title color="black">{`Connect to Netronome at ${ipAddress} or scan the QR code!`}</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <Center>
                <QrCode.Root value={ipAddress} size="lg" colorPalette="black">
                  <QrCode.Frame style={{ fill: "black" }}>
                    <QrCode.Pattern />
                  </QrCode.Frame>
                  <QrCode.DownloadTrigger
                    asChild
                    fileName="netronome.png"
                    mimeType="image/png"
                  >
                    <Button variant="outline" size="xs" mt="3">
                      Download
                    </Button>
                  </QrCode.DownloadTrigger>
                </QrCode.Root>
                </Center>
              </Dialog.Body>
              <Dialog.Footer />
            </Dialog.Content>
          </Dialog.Positioner>
        </Dialog.Root>
    )
}
export default ConnectPopup;