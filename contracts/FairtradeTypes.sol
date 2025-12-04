// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title Shared enums and types for the FairTrade infra contracts
library FairtradeTypes {
    /// @notice Logical role of an organisation in the FairTrade ecosystem.
    enum Role {
        None,
        Producer,
        Processor,
        Logistics,
        Retailer,
        Certifier,
        Regulator,
        Operator // platform-level operator / admin
    }

    /// @notice Registration status of an actor.
    enum Status {
        Unknown,
        Active,
        Suspended,
        Revoked
    }

    /// @notice Fine-grained step type in the supply chain, used in CidRollup.
    enum StepType {
        Unknown,
        Produced,
        Processed,
        Shipped,
        Received,
        AtRetail,
        Sold
    }

    /// @notice Coarse-grained lifecycle status for a product/batch.
    enum ProcessStatus {
        Unknown,
        Created,
        InTransit,
        AtRetail,
        Sold,
        Certified,
        Suspended,
        Revoked
    }
}
