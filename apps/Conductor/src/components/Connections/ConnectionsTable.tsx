import { Table, Status, Spacer, Flex } from "@chakra-ui/react"
import React from "react"
import { Performer, ConnectionStatus } from "../../types"

const ConnectionsTable = ({ members }: { members: Performer[] }) => {

    const statusMap = new Map<ConnectionStatus, string>();
    statusMap.set("Connected", "green");
    statusMap.set("Connecting", "yellow");
    statusMap.set("Disconnected", "red");

    console.log(members);

    const tableBody = members.map((member) => {
        let meanLatency: number | null = null;
        if (member.latencies && member.latencies.length) {
            meanLatency = member.latencies.reduce((a, b) => a + b) / member?.latencies.length
        }
        // console.log("Mean Latency: ", meanLatency);
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

const items = [
    { id: 1, name: "Laptop", category: "Electronics", price: 999.99 },
    { id: 2, name: "Coffee Maker", category: "Home Appliances", price: 49.99 },
    { id: 3, name: "Desk Chair", category: "Furniture", price: 150.0 },
    { id: 4, name: "Smartphone", category: "Electronics", price: 799.99 },
    { id: 5, name: "Headphones", category: "Accessories", price: 199.99 },
]

export default ConnectionsTable;