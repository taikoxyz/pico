// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {HTLC} from "../src/HTLC.sol";

/// @title OracleTest
/// @notice Cross-package consistency check: every digest and HTLC merkle root produced by
///         the state-machine TypeScript helpers must match the on-chain Solidity
///         computation byte-for-byte. The fixture lives at
///         packages/state-machine/test/fixtures/oracle.json and is the canonical reference
///         for both sides of the protocol.
contract OracleTest is Test {
    using stdJson for string;

    // EIP-712 domain typehash (matches Adjudicator's OZ EIP712Upgradeable usage).
    bytes32 internal constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    // Type hashes — must agree with Adjudicator.sol verbatim.
    bytes32 internal constant CHANNEL_STATE_TYPEHASH = keccak256(
        "ChannelState(bytes32 channelId,uint64 version,uint256 balanceA,uint256 balanceB,bytes32 htlcsRoot,uint16 htlcsCount,uint256 htlcsTotalLocked,bool finalized)"
    );
    bytes32 internal constant HTLC_TYPEHASH =
        keccak256("Htlc(bytes32 id,uint256 amount,bytes32 paymentHash,uint64 expiry,uint8 direction)");
    bytes32 internal constant UPDATE_TYPEHASH = keccak256(
        "Update(bytes32 channelId,uint64 fromVersion,uint64 toVersion,ChannelState nextState)ChannelState(bytes32 channelId,uint64 version,uint256 balanceA,uint256 balanceB,bytes32 htlcsRoot,uint16 htlcsCount,uint256 htlcsTotalLocked,bool finalized)"
    );
    bytes32 internal constant COOPERATIVE_CLOSE_TYPEHASH = keccak256(
        "CooperativeClose(bytes32 channelId,uint64 version,uint256 finalBalanceA,uint256 finalBalanceB,uint64 signedAt,uint64 validUntil)"
    );

    string internal json;
    bytes32 internal domainSeparator;

    // Foundry decodes JSON object arrays into structs with fields ordered alphabetically by key.
    struct RawHtlc {
        string amount; // decimal string
        string direction; // "AtoB" or "BtoA"
        string expiryMs; // decimal string
        bytes32 id;
        bytes32 paymentHash;
    }

    function setUp() public {
        string memory path = string.concat(vm.projectRoot(), "/../state-machine/test/fixtures/oracle.json");
        json = vm.readFile(path);

        uint256 chainId = json.readUint(".domain.chainId");
        address verifyingContract = json.readAddress(".domain.verifyingContract");
        domainSeparator = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH, keccak256(bytes("pico")), keccak256(bytes("2")), chainId, verifyingContract
            )
        );
    }

    function _hashState(
        bytes32 channelId,
        uint64 version,
        uint256 balA,
        uint256 balB,
        bytes32 htlcsRoot,
        uint16 htlcsCount,
        uint256 htlcsTotalLocked,
        bool finalized
    ) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                CHANNEL_STATE_TYPEHASH,
                channelId,
                version,
                balA,
                balB,
                htlcsRoot,
                htlcsCount,
                htlcsTotalLocked,
                finalized
            )
        );
    }

    function _eip712(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }

    function _u64(string memory s) internal pure returns (uint64) {
        return uint64(vm.parseUint(s));
    }

    function _u256(string memory s) internal pure returns (uint256) {
        return vm.parseUint(s);
    }

    function _direction(string memory s) internal pure returns (uint8) {
        bytes32 h = keccak256(bytes(s));
        if (h == keccak256(bytes("AtoB"))) return 0;
        if (h == keccak256(bytes("BtoA"))) return 1;
        revert("unknown direction");
    }

    function _readHtlcs(string memory base) internal view returns (HTLC.Lock[] memory) {
        bytes memory raw = json.parseRaw(string.concat(base, ".input.htlcs"));
        RawHtlc[] memory rawHtlcs = abi.decode(raw, (RawHtlc[]));
        HTLC.Lock[] memory locks = new HTLC.Lock[](rawHtlcs.length);
        for (uint256 i = 0; i < rawHtlcs.length; i++) {
            locks[i] = HTLC.Lock({
                id: rawHtlcs[i].id,
                amount: _u256(rawHtlcs[i].amount),
                paymentHash: rawHtlcs[i].paymentHash,
                expiry: _u64(rawHtlcs[i].expiryMs) / 1000,
                direction: _direction(rawHtlcs[i].direction)
            });
        }
        return locks;
    }

    function test_channelStateDigestsAndRootsMatchOracle() public view {
        for (uint256 i = 0; i < 12; i++) {
            string memory base = string.concat(".channelState[", vm.toString(i), "]");
            bytes32 expectedDigest = json.readBytes32(string.concat(base, ".digest"));
            bytes32 expectedRoot = json.readBytes32(string.concat(base, ".htlcsRoot"));

            bytes32 channelId = json.readBytes32(string.concat(base, ".input.channelId"));
            uint64 version = _u64(json.readString(string.concat(base, ".input.version")));
            uint256 balA = _u256(json.readString(string.concat(base, ".input.balanceA")));
            uint256 balB = _u256(json.readString(string.concat(base, ".input.balanceB")));
            uint16 htlcsCount = uint16(_u256(json.readString(string.concat(base, ".input.htlcsCount"))));
            uint256 htlcsTotalLocked = _u256(json.readString(string.concat(base, ".input.htlcsTotalLocked")));
            bool finalized = json.readBool(string.concat(base, ".input.finalized"));

            HTLC.Lock[] memory locks = _readHtlcs(base);
            bytes32 root = HTLC.rootOf(locks);
            assertEq(root, expectedRoot, "htlcsRoot mismatch (TS vs Solidity)");

            bytes32 structHash =
                _hashState(channelId, version, balA, balB, root, htlcsCount, htlcsTotalLocked, finalized);
            assertEq(_eip712(structHash), expectedDigest, "ChannelState digest mismatch");
        }
    }

    function test_htlcDigestsMatchOracle() public view {
        for (uint256 i = 0; i < 12; i++) {
            string memory base = string.concat(".htlc[", vm.toString(i), "]");
            bytes32 expectedDigest = json.readBytes32(string.concat(base, ".digest"));

            bytes32 id = json.readBytes32(string.concat(base, ".input.id"));
            string memory dirStr = json.readString(string.concat(base, ".input.direction"));
            uint256 amount = _u256(json.readString(string.concat(base, ".input.amount")));
            bytes32 paymentHash = json.readBytes32(string.concat(base, ".input.paymentHash"));
            uint64 expirySec = _u64(json.readString(string.concat(base, ".input.expiryMs"))) / 1000;
            uint8 direction = _direction(dirStr);

            bytes32 structHash = keccak256(abi.encode(HTLC_TYPEHASH, id, amount, paymentHash, expirySec, direction));
            assertEq(_eip712(structHash), expectedDigest, "Htlc digest mismatch");
        }
    }

    function test_updateDigestsMatchOracle() public view {
        for (uint256 i = 0; i < 12; i++) {
            string memory base = string.concat(".update[", vm.toString(i), "]");
            bytes32 expectedDigest = json.readBytes32(string.concat(base, ".digest"));

            bytes32 channelId = json.readBytes32(string.concat(base, ".input.channelId"));
            uint64 fromVersion = _u64(json.readString(string.concat(base, ".input.fromVersion")));
            uint64 toVersion = _u64(json.readString(string.concat(base, ".input.toVersion")));

            string memory ns = string.concat(base, ".input.nextState");
            bytes32 nsChannelId = json.readBytes32(string.concat(ns, ".channelId"));
            uint64 nsVersion = _u64(json.readString(string.concat(ns, ".version")));
            uint256 nsBalA = _u256(json.readString(string.concat(ns, ".balanceA")));
            uint256 nsBalB = _u256(json.readString(string.concat(ns, ".balanceB")));
            uint16 nsHtlcsCount = uint16(_u256(json.readString(string.concat(ns, ".htlcsCount"))));
            uint256 nsHtlcsTotalLocked = _u256(json.readString(string.concat(ns, ".htlcsTotalLocked")));
            bool nsFinalized = json.readBool(string.concat(ns, ".finalized"));

            HTLC.Lock[] memory locks = _readHtlcsAt(string.concat(ns, ".htlcs"));
            bytes32 nsRoot = HTLC.rootOf(locks);

            bytes32 nextHash = _hashState(
                nsChannelId, nsVersion, nsBalA, nsBalB, nsRoot, nsHtlcsCount, nsHtlcsTotalLocked, nsFinalized
            );
            bytes32 structHash = keccak256(abi.encode(UPDATE_TYPEHASH, channelId, fromVersion, toVersion, nextHash));
            assertEq(_eip712(structHash), expectedDigest, "Update digest mismatch");
        }
    }

    function _readHtlcsAt(string memory path) internal view returns (HTLC.Lock[] memory) {
        bytes memory raw = json.parseRaw(path);
        RawHtlc[] memory rawHtlcs = abi.decode(raw, (RawHtlc[]));
        HTLC.Lock[] memory locks = new HTLC.Lock[](rawHtlcs.length);
        for (uint256 i = 0; i < rawHtlcs.length; i++) {
            locks[i] = HTLC.Lock({
                id: rawHtlcs[i].id,
                amount: _u256(rawHtlcs[i].amount),
                paymentHash: rawHtlcs[i].paymentHash,
                expiry: _u64(rawHtlcs[i].expiryMs) / 1000,
                direction: _direction(rawHtlcs[i].direction)
            });
        }
        return locks;
    }

    function test_cooperativeCloseDigestsMatchOracle() public view {
        for (uint256 i = 0; i < 12; i++) {
            string memory base = string.concat(".cooperativeClose[", vm.toString(i), "]");
            bytes32 expectedDigest = json.readBytes32(string.concat(base, ".digest"));

            bytes32 channelId = json.readBytes32(string.concat(base, ".input.channelId"));
            uint64 version = _u64(json.readString(string.concat(base, ".input.version")));
            uint256 finalA = _u256(json.readString(string.concat(base, ".input.finalBalanceA")));
            uint256 finalB = _u256(json.readString(string.concat(base, ".input.finalBalanceB")));
            uint64 signedAt = _u64(json.readString(string.concat(base, ".input.signedAt")));
            uint64 validUntil = _u64(json.readString(string.concat(base, ".input.validUntil")));

            bytes32 structHash = keccak256(
                abi.encode(COOPERATIVE_CLOSE_TYPEHASH, channelId, version, finalA, finalB, signedAt, validUntil)
            );
            assertEq(_eip712(structHash), expectedDigest, "CooperativeClose digest mismatch");
        }
    }
}
