use poseidon::poseidon2::Poseidon2;

fn vendor_is_approved(vendor: Field, v0: Field, v1: Field, v2: Field, v3: Field) -> bool {
    let mut ok = false;
    if vendor == v0 {
        ok = true;
    }
    if vendor == v1 {
        ok = true;
    }
    if vendor == v2 {
        ok = true;
    }
    if vendor == v3 {
        ok = true;
    }
    ok
}

fn policy_commitment_from_parts(
    spending_limit: u64,
    window_start: u64,
    window_end: u64,
    v0: Field,
    v1: Field,
    v2: Field,
    v3: Field,
) -> Field {
    let limit_f = spending_limit as Field;
    let start_f = window_start as Field;
    let end_f = window_end as Field;
    Poseidon2::hash([limit_f, start_f, end_f, v0, v1, v2, v3], 7)
}

fn main(
    spending_limit: u64,
    tx_nonce: Field,
    window_start: u64,
    window_end: u64,
    approved_vendor_0: Field,
    approved_vendor_1: Field,
    approved_vendor_2: Field,
    approved_vendor_3: Field,
    payment_amount: pub u64,
    current_time: pub u64,
    vendor: pub Field,
    policy_commitment: pub Field,
    nullifier: pub Field,
) {
    assert(payment_amount <= spending_limit);

    assert(window_start <= current_time);
    assert(current_time <= window_end);

    assert(vendor_is_approved(
        vendor,
        approved_vendor_0,
        approved_vendor_1,
        approved_vendor_2,
        approved_vendor_3,
    ));

    let expected_commitment = policy_commitment_from_parts(
        spending_limit,
        window_start,
        window_end,
        approved_vendor_0,
        approved_vendor_1,
        approved_vendor_2,
        approved_vendor_3,
    );
    assert(expected_commitment == policy_commitment);

    let computed_nullifier = Poseidon2::hash([tx_nonce], 1);
    assert(computed_nullifier == nullifier);
}
