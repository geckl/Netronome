import { Table, Status, Spacer, Flex } from "@chakra-ui/react"
import { Performer, ConnectionStatus } from "../../types"

const ConnectionsTable = ({ members }: { members: Performer[] }) => {

    const statusMap = new Map<ConnectionStatus, string>();
    statusMap.set("Connected", "green");
    statusMap.set("Connecting", "yellow");
    statusMap.set("Disconnected", "red");

    const tableBody = members.map((member) => {
        let meanLatency: number | null = null;
        if (member.latencies && member.latencies.length) {
            meanLatency = Math.round(member.latencies.reduce((a, b) => a + b) / member.latencies.length)
        }
        return (
            <Table.Row key={member.id}>
                <Table.Cell textAlign="start">{member.name}</Table.Cell>
                <Table.Cell textAlign="center">
                <Flex alignItems="center">
                    <Spacer />
                        <Status.Root colorPalette={statusMap.get(member.status)} size={"lg"} >
                            <Status.Indicator />
                        </Status.Root>
                    <Spacer />
                    </Flex>
                </Table.Cell>
                <Table.Cell textAlign="end">{meanLatency}</Table.Cell>
            </Table.Row>
        )
    })

    return (
        <Table.Root size="sm" striped>
            <Table.Header>
                <Table.Row>
                    <Table.ColumnHeader textAlign="start">Name</Table.ColumnHeader>
                    <Table.ColumnHeader textAlign="center">Status</Table.ColumnHeader>
                    <Table.ColumnHeader textAlign="end">Latency (ms)</Table.ColumnHeader>
                </Table.Row>
            </Table.Header>
            <Table.Body>
                {tableBody}
            </Table.Body>
        </Table.Root>
    )
}

export default ConnectionsTable;