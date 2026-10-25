import {
  Button,
  Badge,
  CloseButton,
  Drawer,
  Status,
  Portal,
  HStack,
} from "@chakra-ui/react"
import ConnectionsTable from "./ConnectionsTable"
import { Performer } from "../../types"

const ConnectionsDrawer = ({members}: {members: Performer[]}) => {
  return (
    <Drawer.Root size="md">
      <Drawer.Trigger asChild>
        <Button size="sm" colorPalette="cyan">
          Performers
          <Badge colorPalette="gray" variant="subtle">
            {members.length}
          </Badge>
        </Button>
      </Drawer.Trigger>
      <Portal>
        <Drawer.Backdrop />
        <Drawer.Positioner>
          <Drawer.Content>
            <Drawer.Header>
              <Drawer.Title>Performers</Drawer.Title>
            </Drawer.Header>
            <Drawer.Body>
              <ConnectionsTable members={members}></ConnectionsTable>
            </Drawer.Body>
            <Drawer.Footer>
              {/* Color key for the status dots in the table */}
              <HStack gap="4" mx="auto" wrap="wrap" justify="center">
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
              </HStack>
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