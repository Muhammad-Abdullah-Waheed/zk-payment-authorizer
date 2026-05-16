use poseidon::poseidon2::Poseidon2;

fn main(
    spending_limit: u64,
    tx_nonce: Field,

    payment_amount: pub u64,
    nullifier: pub Field,
) {
    assert(payment_amount <= spending_limit);

    let computed_nullifier = Poseidon2::hash([tx_nonce], 1);
    assert(computed_nullifier == nullifier);
}
