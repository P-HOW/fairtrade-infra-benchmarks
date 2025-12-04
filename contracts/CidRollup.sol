// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./FairtradeTypes.sol";

interface IActorRegistryForCid {
    function isActiveActor(address wallet) external view returns (bool);

    function getActor(address wallet)
    external
    view
    returns (bytes32 orgIdHash, FairtradeTypes.Role role, FairtradeTypes.Status status, bytes32 metadataHash);
}

/// @title CidRollup
/// @notice High-throughput batch anchor for IPFS CID hashes corresponding to supply-chain steps.
/// @dev Designed for TPS benchmarking – minimal validation, heavy use of events.
contract CidRollup {
    IActorRegistryForCid public immutable actorRegistry;

    struct CidEvent {
        bytes32 productId;
        bytes32 stepId;
        bytes32 cidHash;
        uint8 stepType; // FairtradeTypes.StepType, serialized as uint8
    }

    /// @dev Emitted for each event in a submitted batch.
    event CidAnchored(
        bytes32 indexed productId,
        bytes32 indexed stepId,
        bytes32 cidHash,
        uint8 stepType,
        bytes32 indexed orgIdHash,
        address actor
    );

    /// @dev Emitted once per batch for simpler indexing.
    event CidBatchSubmitted(address indexed submitter, uint256 count);

    /// @notice Optional anti-replay protection: productId + stepId must be unique.
    mapping(bytes32 => bool) public usedStepKey;

    constructor(address _actorRegistry) {
        require(_actorRegistry != address(0), "CidRollup: actorRegistry is zero");
        actorRegistry = IActorRegistryForCid(_actorRegistry);
    }

    function _stepKey(bytes32 productId, bytes32 stepId) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(productId, stepId));
    }

    /// @notice Submit a batch of CID events.
    /// @dev All detailed data is pushed into events; storage only tracks replay protection.
    function submitCidBatch(CidEvent[] calldata events) external {
        require(events.length > 0, "CidRollup: empty batch");
        require(actorRegistry.isActiveActor(msg.sender), "CidRollup: sender not registered");

        (bytes32 orgIdHash, , FairtradeTypes.Status status, ) = actorRegistry.getActor(msg.sender);
        require(status == FairtradeTypes.Status.Active, "CidRollup: actor not active");

        uint256 len = events.length;
        for (uint256 i = 0; i < len; ++i) {
            CidEvent calldata e = events[i];

            bytes32 key = _stepKey(e.productId, e.stepId);
            require(!usedStepKey[key], "CidRollup: step already anchored");
            usedStepKey[key] = true;

            emit CidAnchored(e.productId, e.stepId, e.cidHash, e.stepType, orgIdHash, msg.sender);
        }

        emit CidBatchSubmitted(msg.sender, len);
    }
}
