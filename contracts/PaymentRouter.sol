// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./FairtradeTypes.sol";

interface IActorRegistryForPayments {
    function getActor(address wallet)
    external
    view
    returns (bytes32 orgIdHash, FairtradeTypes.Role role, FairtradeTypes.Status status, bytes32 metadataHash);
}

/// @title PaymentRouter
/// @notice Splits FairTrade premiums among stakeholders using basis-point splits.
/// @dev For benchmarking this implementation only handles ETH payments.
contract PaymentRouter {
    IActorRegistryForPayments public immutable actorRegistry;

    struct Split {
        address recipient;
        uint16 bps; // basis points (1/100 of a percent)
    }

    Split[] private _splits;
    uint16 public totalBps;

    event SplitConfigured(address indexed recipient, uint16 bps);
    event PaymentReceived(bytes32 indexed productId, address indexed payer, uint256 amount);
    event PaymentRouted(bytes32 indexed productId, address indexed recipient, uint256 amount);

    constructor(
        address _actorRegistry,
        address[] memory recipients,
        uint16[] memory bps
    ) {
        require(_actorRegistry != address(0), "PaymentRouter: actorRegistry is zero");
        require(recipients.length == bps.length, "PaymentRouter: length mismatch");
        require(recipients.length > 0, "PaymentRouter: empty splits");

        actorRegistry = IActorRegistryForPayments(_actorRegistry);

        uint16 running;
        for (uint256 i = 0; i < recipients.length; ++i) {
            require(recipients[i] != address(0), "PaymentRouter: zero recipient");
            require(bps[i] > 0, "PaymentRouter: zero bps");

            _splits.push(Split({recipient: recipients[i], bps: bps[i]}));
            running += bps[i];

            emit SplitConfigured(recipients[i], bps[i]);
        }

        require(running <= 10_000, "PaymentRouter: total bps > 10000");
        totalBps = running;
    }

    /// @notice Route an ETH payment for a given product/batch.
    /// @dev msg.value is split according to configured basis points. Any remainder stays in the contract.
    function routePayment(bytes32 productId) external payable {
        require(msg.value > 0, "PaymentRouter: zero value");

        (, , FairtradeTypes.Status status, ) = actorRegistry.getActor(msg.sender);
        require(status == FairtradeTypes.Status.Active, "PaymentRouter: actor not active");

        emit PaymentReceived(productId, msg.sender, msg.value);

        uint256 amount = msg.value;
        for (uint256 i = 0; i < _splits.length; ++i) {
            Split memory s = _splits[i];
            uint256 share = (amount * s.bps) / 10_000;
            if (share > 0) {
                (bool ok, ) = s.recipient.call{value: share}("");
                require(ok, "PaymentRouter: transfer failed");
                emit PaymentRouted(productId, s.recipient, share);
            }
        }
    }

    function getSplits() external view returns (Split[] memory) {
        Split[] memory local = new Split[](_splits.length);
        for (uint256 i = 0; i < _splits.length; ++i) {
            local[i] = _splits[i];
        }
        return local;
    }

    /// @dev Allow the contract to receive ETH (e.g., reimbursements, manual top-ups).
    receive() external payable {}
}
