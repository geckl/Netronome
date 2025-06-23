import {
  Button,
  CloseButton,
  Drawer,
  Status,
  Portal,
  VStack,
} from "@chakra-ui/react"
import React, { useRef } from "react"
import ConnectionsTable from "./ConnectionsTable"
import { Performer } from "../../types"

const ConnectionsDrawer = ({members}: {members: Performer[]}) => {
  const ref = useRef<HTMLInputElement>(null)
  return (
    <Drawer.Root initialFocusEl={() => ref.current}>
      <Drawer.Trigger asChild>
        <Button size="sm" bg="brand.500">
          Performers
        </Button>
      </Drawer.Trigger>
      <Portal>
        <Drawer.Backdrop />
        <Drawer.Positioner>
          <Drawer.Content>
            <Drawer.Header>
              <Drawer.Title>Drawer Title</Drawer.Title>
            </Drawer.Header>
            <Drawer.Body>
              <ConnectionsTable members={members}></ConnectionsTable>
              {/* <Stack mt="5">
                <Input defaultValue="Naruto" placeholder="First name" />
                <Input ref={ref} placeholder="Email" />
              </Stack> */}
            </Drawer.Body>
            <Drawer.Footer>
            <VStack gap="6">
                <Status.Root colorPalette="red">
                    <Status.Indicator />
                    Disconnected
                </Status.Root>
                <Status.Root colorPalette="yellow">
                    <Status.Indicator />
                    Connecting
                </Status.Root>
                <Status.Root colorPalette="green">
                    <Status.Indicator />
                    Connected
                </Status.Root>
            </VStack>
              <Button variant="outline">Cancel</Button>
              <Button>Save</Button>
            </Drawer.Footer>
            <Drawer.CloseTrigger asChild>
              <CloseButton size="sm" />
            </Drawer.CloseTrigger>
          </Drawer.Content>
        </Drawer.Positioner>
      </Portal>
    </Drawer.Root>
  )
}

export default ConnectionsDrawer;