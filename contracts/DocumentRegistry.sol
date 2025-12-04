// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./FairtradeTypes.sol";

interface IActorRegistryForDocs {
    function isActiveActor(address wallet) external view returns (bool);

    function getActor(address wallet)
    external
    view
    returns (bytes32 orgIdHash, FairtradeTypes.Role role, FairtradeTypes.Status status, bytes32 metadataHash);
}

/// @title DocumentRegistry
/// @notice Anchors IPFS documents (evidence, reports, certificates) on-chain via events only.
/// @dev No per-document storage – everything is in events to keep gas low.
contract DocumentRegistry {
    IActorRegistryForDocs public immutable actorRegistry;

    event DocumentAnchored(
        bytes32 indexed productId,
        bytes32 indexed stepId,
        bytes32 cidHash,
        uint8 docType,
        bytes32 indexed orgIdHash,
        address actor
    );

    constructor(address _actorRegistry) {
        require(_actorRegistry != address(0), "DocumentRegistry: actorRegistry is zero");
        actorRegistry = IActorRegistryForDocs(_actorRegistry);
    }

    /// @notice Anchor a single document (e.g., PDF, photo, report) via its CID hash.
    function anchorDocument(
        bytes32 productId,
        bytes32 stepId,
        bytes32 cidHash,
        uint8 docType
    ) external {
        require(actorRegistry.isActiveActor(msg.sender), "DocumentRegistry: sender not active");

        (bytes32 orgIdHash, , FairtradeTypes.Status status, ) = actorRegistry.getActor(msg.sender);
        require(status == FairtradeTypes.Status.Active, "DocumentRegistry: actor not active");

        // All information is emitted as an event to keep storage minimal.
        emit DocumentAnchored(productId, stepId, cidHash, docType, orgIdHash, msg.sender);
    }
}
