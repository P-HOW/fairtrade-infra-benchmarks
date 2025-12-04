// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./FairtradeTypes.sol";

interface IActorRegistryForProcess {
    function getActor(address wallet)
    external
    view
    returns (bytes32 orgIdHash, FairtradeTypes.Role role, FairtradeTypes.Status status, bytes32 metadataHash);
}

/// @title ProcessManager
/// @notice Maintains coarse-grained lifecycle status for product/batch IDs.
/// @dev Very simple monotonic state machine; heavy details live off-chain.
contract ProcessManager {
    IActorRegistryForProcess public immutable actorRegistry;

    struct Process {
        FairtradeTypes.ProcessStatus status;
        bytes32 creatorOrgId;
    }

    // productId => process metadata
    mapping(bytes32 => Process) private _processes;

    event ProcessCreated(bytes32 indexed productId, bytes32 indexed orgIdHash);

    event ProcessStatusChanged(
        bytes32 indexed productId,
        FairtradeTypes.ProcessStatus previousStatus,
        FairtradeTypes.ProcessStatus newStatus,
        bytes32 indexed orgIdHash,
        address actor
    );

    constructor(address _actorRegistry) {
        require(_actorRegistry != address(0), "ProcessManager: actorRegistry is zero");
        actorRegistry = IActorRegistryForProcess(_actorRegistry);
    }

    modifier onlyActiveActor() {
        (, , FairtradeTypes.Status status, ) = actorRegistry.getActor(msg.sender);
        require(status == FairtradeTypes.Status.Active, "ProcessManager: actor not active");
        _;
    }

    /// @notice Create a new process for a product/batch ID.
    /// @dev Typically called by producers/processors at the beginning of the chain.
    function createProcess(bytes32 productId) external onlyActiveActor {
        require(productId != bytes32(0), "ProcessManager: zero productId");
        Process storage p = _processes[productId];
        require(p.status == FairtradeTypes.ProcessStatus.Unknown, "ProcessManager: already exists");

        (bytes32 orgIdHash, , , ) = actorRegistry.getActor(msg.sender);

        p.status = FairtradeTypes.ProcessStatus.Created;
        p.creatorOrgId = orgIdHash;

        emit ProcessCreated(productId, orgIdHash);
        emit ProcessStatusChanged(
            productId,
            FairtradeTypes.ProcessStatus.Unknown,
            FairtradeTypes.ProcessStatus.Created,
            orgIdHash,
            msg.sender
        );
    }

    /// @notice Advance the lifecycle status of a product/batch.
    /// @dev Enforces a simple monotonic rule: newStatus must be strictly greater than current.
    function advanceStatus(bytes32 productId, FairtradeTypes.ProcessStatus newStatus) external onlyActiveActor {
        require(newStatus != FairtradeTypes.ProcessStatus.Unknown, "ProcessManager: invalid status");

        Process storage p = _processes[productId];
        require(p.status != FairtradeTypes.ProcessStatus.Unknown, "ProcessManager: process missing");

        FairtradeTypes.ProcessStatus oldStatus = p.status;
        require(uint8(newStatus) > uint8(oldStatus), "ProcessManager: non-monotonic");

        (bytes32 orgIdHash, , , ) = actorRegistry.getActor(msg.sender);

        p.status = newStatus;

        emit ProcessStatusChanged(productId, oldStatus, newStatus, orgIdHash, msg.sender);
    }

    function getStatus(bytes32 productId) external view returns (FairtradeTypes.ProcessStatus) {
        return _processes[productId].status;
    }

    function getProcess(bytes32 productId) external view returns (FairtradeTypes.ProcessStatus, bytes32) {
        Process memory p = _processes[productId];
        return (p.status, p.creatorOrgId);
    }
}
