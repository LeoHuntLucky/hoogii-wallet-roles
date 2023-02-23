import {
    AugSchemeMPL,
    bigIntToBytes,
    concatBytes,
    fromHex,
    intToBytes,
    PrivateKey,
} from '@rigidity/bls-signatures'
import { ConditionOpcode, sanitizeHex } from '@rigidity/chia'
import { Program } from '@rigidity/clvm'
import { bech32m } from 'bech32'
import zlib from 'react-zlib-js'

import { callGetBalance } from '~/api/api'
import { ChainEnum } from '~/types/chia'
import { OfferAsset } from '~/types/extension'
import { StorageEnum } from '~/types/storage'
import Announcement from '~/utils/Announcement'
import { CAT } from '~/utils/CAT'
import CoinSpend from '~/utils/CoinSpend'
import { getStorage } from '~/utils/extension/storage'
import { puzzles } from '~/utils/puzzles'
import Secure from '~/utils/Secure'
import SpendBundle from '~/utils/SpendBundle'
import type { Coin } from '~/utils/Wallet/types'
import { Wallet } from '~/utils/Wallet/Wallet'

import { chains } from './constants'

const initDict = [
    puzzles.wallet.serializeHex() + puzzles.catOld.serializeHex(),
    puzzles.settlementPaymentsOld.serializeHex(),
    puzzles.singletonTopLayerV1.serializeHex() +
        puzzles.nftStateLayer.serializeHex() +
        puzzles.nftOwnershipLayer.serializeHex() +
        puzzles.nftMetadataUpdaterDefault.serializeHex() +
        puzzles.nftOwnershipTransferProgramOneWayClaimWithRoyalties.serializeHex(),

    puzzles.cat.serializeHex(),
    puzzles.settlementPayments.serializeHex(),
]
export default class Offer {
    public bundle: SpendBundle

    constructor(bundle: SpendBundle) {
        this.bundle = bundle
    }

    getDictForVersion(ver: number) {
        return concatBytes(
            ...initDict.slice(0, ver).map((item) => fromHex(item))
        )
    }

    static toMsg = ({
        payment: { amount, memo, assetId },
        puzzle_hash,
    }: {
        payment: OfferAsset
        puzzle_hash: string
    }): Program => {
        const nonce = this.getNonce()
        return Program.fromList([
            Program.fromHex(Program.fromBytes(nonce).toHex()),
            Program.fromList([
                Program.fromHex(sanitizeHex(puzzle_hash)),
                Program.fromBigInt(BigInt(amount)),
                Program.fromList([
                    ...(assetId ? [Program.fromHex(puzzle_hash)] : []),
                    ...(memo ? [Program.fromSource(memo)] : []),
                ]),
            ]),
        ])
    }

    static getNonce = () => {
        const nonceArr = new Uint8Array(256 / 8)

        return nonceArr
    }

    static generateSettlement = (assetId: string | undefined) => {
        if (assetId) {
            return new CAT(
                fromHex(sanitizeHex(assetId)),
                puzzles.settlementPaymentsOld
            )
        } else {
            return puzzles.settlementPaymentsOld
        }
    }

    static async generateSecureBundle(
        requestAssets: OfferAsset[],
        offerPaymentList: OfferAsset[],
        fee: string = '0'
    ) {
        const settlement = this.generateSettlement(undefined)
        // verify is unlock
        const seed = await Secure.getSeed()
        const puzzle = await Secure.getPuzzle()
        const puzzleHash = puzzle.hashHex()

        const requestPaymentAnnouncements: Announcement[] = requestAssets.map(
            (payment) => {
                const message = Offer.toMsg({
                    payment,
                    puzzle_hash: puzzleHash,
                })

                const settlement = Offer.generateSettlement(payment.assetId)
                return new Announcement(settlement.hashHex(), message)
            }
        )
        // bind coinSpend
        const spendList: CoinSpend[] = []
        requestAssets.forEach(({ assetId, amount, memo }) => {
            const coin: Coin = {
                parent_coin_info:
                    '0x0000000000000000000000000000000000000000000000000000000000000000',
                puzzle_hash: Offer.generateSettlement(assetId).hashHex(),
                amount: 0n,
            }
            const nonce = this.getNonce()
            const settlementSolution = Program.fromList([
                Program.fromList([
                    Program.fromHex(Program.fromBytes(nonce).toHex()),
                    Program.fromList([
                        Program.fromHex(sanitizeHex(puzzleHash)),
                        Program.fromBigInt(BigInt(amount)),
                        Program.fromList([
                            ...(assetId ? [Program.fromHex(puzzleHash)] : []),
                            ...(memo ? [Program.fromSource(memo)] : []),
                        ]),
                    ]),
                ]),
            ])

            const coinSpend = new CoinSpend(
                coin,
                this.generateSettlement(assetId).serializeHex(),
                settlementSolution.serializeHex()
            )
            spendList.push(coinSpend)
        })

        const announcementAssertions = requestPaymentAnnouncements.map(
            (announcement) =>
                Program.fromList([
                    Program.fromHex(
                        sanitizeHex(ConditionOpcode.ASSERT_PUZZLE_ANNOUNCEMENT)
                    ),
                    Program.fromHex(announcement.name().toHex()),
                ])
        )

        for (let i = 0; i < offerPaymentList.length; i++) {
            const offerPayment = offerPaymentList[i]

            const memos: string[] = []
            if (offerPayment.memo) {
                memos.push(offerPayment.memo)
            }

            if (offerPayment.assetId) {
                const assetId = fromHex(offerPayment.assetId)
                const cat = new CAT(assetId, puzzle)
                const masterPrivateKey = PrivateKey.fromSeed(seed)
                const walletPrivateKey =
                    Wallet.derivePrivateKey(masterPrivateKey)
                const walletPublicKey = walletPrivateKey.getG1()
                const wallet = new Wallet(walletPublicKey, {
                    hardened: true,
                    index: 0,
                })
                const {
                    data: { data },
                } = await callGetBalance({
                    puzzle_hash: Program.fromBytes(cat.hash()).toHex(),
                })
                if (BigInt(data) < BigInt(offerPayment.amount)) {
                    throw new Error("You don't have enough coin to spend")
                }

                const CATCoinSpendList = await CAT.generateCATSpendList({
                    wallet,
                    amount: BigInt(offerPayment.amount),
                    targetPuzzleHash: settlement.hashHex(),
                    spendableCoinList: await Wallet.getCoinList(cat.hashHex()),
                    assetId,
                    additionalConditions: announcementAssertions,
                    memos,
                })

                spendList.push(...CATCoinSpendList)
                // if offer cat and add fee in first coin
                if (BigInt(fee) > 0n) {
                    console.log('if offer cat and add fee in first coin')
                    const feeSpendList = await Wallet.generateXCHSpendList({
                        fee: BigInt(fee),
                        amount: 0n,
                        targetPuzzleHash: '',
                        puzzle,
                        spendableCoinList: await Wallet.getCoinList(puzzleHash),
                    })
                    spendList.push(...feeSpendList)
                }
            } else {
                const XCHSpendList = await Wallet.generateXCHSpendList({
                    fee: BigInt(fee), // add fee in first coin
                    amount: BigInt(offerPayment.amount),
                    targetPuzzleHash: settlement.hashHex(),
                    puzzle,
                    spendableCoinList: await Wallet.getCoinList(puzzleHash),
                    additionalConditions: announcementAssertions,
                    memos,
                })
                spendList.push(...XCHSpendList)
            }
        }
        const chain =
            chains[
                (await getStorage<ChainEnum>(StorageEnum.chainId)) ||
                    ChainEnum.Mainnet
            ]

        const signatures = AugSchemeMPL.aggregate(
            spendList
                .filter((spend) => spend.coin.amount)
                .map((item) =>
                    Wallet.signCoinSpend(
                        item,
                        Buffer.from(chain.agg_sig_me_additional_data, 'hex'),
                        Wallet.derivePrivateKey(PrivateKey.fromSeed(seed)),
                        Wallet.derivePrivateKey(
                            PrivateKey.fromSeed(seed)
                        ).getG1()
                    )
                )
        )
        const spendBundle = new SpendBundle(spendList, signatures)
        return spendBundle
    }

    getId() {
        return this.bundle.getTXID()
    }

    encode(ver: number, prefix = 'offer') {
        const offerName = concatBytes(
            intToBytes(this.bundle.coin_spends.length, 4, 'big'),
            ...this.bundle.coin_spends.map((coinSpend) =>
                concatBytes(
                    fromHex(sanitizeHex(coinSpend.coin.parent_coin_info)),
                    fromHex(sanitizeHex(coinSpend.coin.puzzle_hash)),
                    bigIntToBytes(BigInt(coinSpend.coin.amount), 8, 'big'),
                    fromHex(sanitizeHex(coinSpend.puzzle_reveal)),
                    fromHex(sanitizeHex(coinSpend.solution))
                )
            ),
            Program.fromHex(
                sanitizeHex(this.bundle.aggregated_signature.toHex())
            ).toBytes()
        )

        const def = zlib.deflateSync(Buffer.from(offerName), {
            dictionary: Buffer.from(this.getDictForVersion(ver)),
        })

        const final_buff = concatBytes(intToBytes(ver, 2, 'big'), def)
        const words = bech32m.toWords(final_buff)
        const encoded = bech32m.encode(
            prefix,
            words,
            prefix.length + 7 + words.length
        )

        return encoded
    }

    static decode(offerString: string) {
        const offer_compressed = bech32m.decode(offerString).words
        console.log('offer_compressed>', offer_compressed)
    }
}