// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./FairtradeTypes.sol";

/// @title ActorRegistry
/// @notice Registry of all organisations participating in the FairTrade network.
/// @dev Lightweight ownable registry; other contracts query it for role and status.
contract ActorRegistry {
    struct Actor {
        bytes32 orgIdHash;            // hash of off-chain org id
        FairtradeTypes.Role role;     // logical role in the ecosystem
        FairtradeTypes.Status status; // registration status
        bytes32 metadataHash;         // hash of IPFS JSON profile
    }

    address public owner;

    // wallet => actor record
    mapping(address => Actor) private _actors;

    // orgIdHash => primary wallet
    mapping(bytes32 => address) private _walletByOrg;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    event ActorRegistered(
        bytes32 indexed orgIdHash,
        address indexed wallet,
        FairtradeTypes.Role role,
        bytes32 metadataHash
    );

    event ActorUpdated(
        bytes32 indexed orgIdHash,
        address indexed wallet,
        FairtradeTypes.Role role,
        FairtradeTypes.Status status,
        bytes32 metadataHash
    );

    event ActorStatusUpdated(bytes32 indexed orgIdHash, FairtradeTypes.Status status);
    event ActorMetadataUpdated(bytes32 indexed orgIdHash, bytes32 metadataHash);

    modifier onlyOwner() {
        require(msg.sender == owner, "ActorRegistry: only owner");
        _;
    }

    constructor(address _owner) {
        owner = _owner == address(0) ? msg.sender : _owner;
        emit OwnershipTransferred(address(0), owner);
    }

    // ------------------------------------------------------------------------
    // Ownership
    // ------------------------------------------------------------------------

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "ActorRegistry: zero address");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    // ------------------------------------------------------------------------
    // Registration / updates
    // ------------------------------------------------------------------------

    function registerActor(
        bytes32 orgIdHash,
        address wallet,
        FairtradeTypes.Role role,
        bytes32 metadataHash
    ) external onlyOwner {
        require(wallet != address(0), "ActorRegistry: zero wallet");
        require(orgIdHash != bytes32(0), "ActorRegistry: zero orgId");
        require(role != FairtradeTypes.Role.None, "ActorRegistry: invalid role");
        require(_walletByOrg[orgIdHash] == address(0), "ActorRegistry: org exists");
        require(_actors[wallet].orgIdHash == bytes32(0), "ActorRegistry: wallet used");

        Actor memory actor = Actor({
            orgIdHash: orgIdHash,
            role: role,
            status: FairtradeTypes.Status.Active,
            metadataHash: metadataHash
        });

        _actors[wallet] = actor;
        _walletByOrg[orgIdHash] = wallet;

        emit ActorRegistered(orgIdHash, wallet, role, metadataHash);
        emit ActorUpdated(orgIdHash, wallet, role, actor.status, metadataHash);
    }

    function updateActorRole(bytes32 orgIdHash, FairtradeTypes.Role newRole) external onlyOwner {
        require(newRole != FairtradeTypes.Role.None, "ActorRegistry: invalid role");
        address wallet = _walletByOrg[orgIdHash];
        require(wallet != address(0), "ActorRegistry: unknown org");

        Actor storage actor = _actors[wallet];
        actor.role = newRole;

        emit ActorUpdated(orgIdHash, wallet, actor.role, actor.status, actor.metadataHash);
    }

    function updateActorStatus(bytes32 orgIdHash, FairtradeTypes.Status newStatus) external onlyOwner {
        address wallet = _walletByOrg[orgIdHash];
        require(wallet != address(0), "ActorRegistry: unknown org");

        Actor storage actor = _actors[wallet];
        actor.status = newStatus;

        emit ActorStatusUpdated(orgIdHash, newStatus);
        emit ActorUpdated(orgIdHash, wallet, actor.role, newStatus, actor.metadataHash);
    }

    function updateActorMetadata(bytes32 orgIdHash, bytes32 newMetadataHash) external onlyOwner {
        address wallet = _walletByOrg[orgIdHash];
        require(wallet != address(0), "ActorRegistry: unknown org");

        Actor storage actor = _actors[wallet];
        actor.metadataHash = newMetadataHash;

        emit ActorMetadataUpdated(orgIdHash, newMetadataHash);
        emit ActorUpdated(orgIdHash, wallet, actor.role, actor.status, newMetadataHash);
    }

    // ------------------------------------------------------------------------
    // Views for other contracts
    // ------------------------------------------------------------------------

    function getActor(address wallet)
    external
    view
    returns (bytes32 orgIdHash, FairtradeTypes.Role role, FairtradeTypes.Status status, bytes32 metadataHash)
    {
        Actor memory actor = _actors[wallet];
        return (actor.orgIdHash, actor.role, actor.status, actor.metadataHash);
    }

    function getActorByOrg(bytes32 orgIdHash)
    external
    view
    returns (address wallet, FairtradeTypes.Role role, FairtradeTypes.Status status, bytes32 metadataHash)
    {
        wallet = _walletByOrg[orgIdHash];
        Actor memory actor = _actors[wallet];
        return (wallet, actor.role, actor.status, actor.metadataHash);
    }

    function hasRole(address wallet, FairtradeTypes.Role role) external view returns (bool) {
        Actor memory actor = _actors[wallet];
        return actor.role == role && actor.status == FairtradeTypes.Status.Active;
    }

    function isActiveActor(address wallet) external view returns (bool) {
        Actor memory actor = _actors[wallet];
        return actor.orgIdHash != bytes32(0) && actor.status == FairtradeTypes.Status.Active;
    }
}
