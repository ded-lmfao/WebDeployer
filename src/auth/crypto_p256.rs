// ===========================================================================
// Base64URL & Pure-Rust NIST P-256 (secp256r1 / ES256) WebAuthn Verifier
// ===========================================================================
pub fn b64url_encode(data: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(data)
}

pub fn b64url_decode(input: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return None;
    }
    let mut norm: String = trimmed
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '=')
        .map(|c| match c {
            '+' => '-',
            '/' => '_',
            other => other,
        })
        .collect();
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(&norm)
        .ok()
        .or_else(|| {
            while norm.len() % 4 != 0 {
                norm.push('=');
            }
            base64::engine::general_purpose::URL_SAFE.decode(&norm).ok()
        })
}

pub fn extract_p256_pubkey(raw: &[u8]) -> Option<[u8; 65]> {
    if raw.len() == 65 && raw[0] == 0x04 {
        let mut out = [0u8; 65];
        out.copy_from_slice(raw);
        if is_valid_p256_point(&out) {
            return Some(out);
        }
    }
    if raw.len() >= 66 {
        let tail = &raw[raw.len() - 65..];
        if tail[0] == 0x04 {
            let mut out = [0u8; 65];
            out.copy_from_slice(tail);
            if is_valid_p256_point(&out) {
                return Some(out);
            }
        }
        // Scan for DER SubjectPublicKeyInfo BIT STRING header (03 42 00 04 + 64 bytes)
        for i in 0..=raw.len().saturating_sub(68) {
            if raw[i] == 0x03 && raw[i + 1] == 0x42 && raw[i + 2] == 0x00 && raw[i + 3] == 0x04 {
                let mut out = [0u8; 65];
                out.copy_from_slice(&raw[i + 3..i + 68]);
                if is_valid_p256_point(&out) {
                    return Some(out);
                }
            }
        }
    }

    // If `raw` is WebAuthn authenticatorData (flags bit 0x40 set at byte 32),
    // slice directly to the attested credentialPublicKey CBOR map at offset 55 + cred_id_len
    let search_slice = if raw.len() > 55 && (raw[32] & 0x40) != 0 {
        let cred_len = u16::from_be_bytes([raw[53], raw[54]]) as usize;
        if raw.len() > 55 + cred_len {
            &raw[55 + cred_len..]
        } else {
            raw
        }
    } else {
        raw
    };

    let mut x_opt: Option<[u8; 32]> = None;
    let mut y_opt: Option<[u8; 32]> = None;
    if search_slice.len() >= 70 {
        for i in 0..=search_slice.len().saturating_sub(35) {
            if search_slice[i] == 0x21 && search_slice[i + 1] == 0x58 && search_slice[i + 2] == 0x20 {
                let mut x = [0u8; 32];
                x.copy_from_slice(&search_slice[i + 3..i + 35]);
                x_opt = Some(x);
            } else if search_slice[i] == 0x22 && search_slice[i + 1] == 0x58 && search_slice[i + 2] == 0x20 {
                let mut y = [0u8; 32];
                y.copy_from_slice(&search_slice[i + 3..i + 35]);
                y_opt = Some(y);
            }
            if let (Some(x), Some(y)) = (x_opt, y_opt) {
                let mut cand = [0u8; 65];
                cand[0] = 0x04;
                cand[1..33].copy_from_slice(&x);
                cand[33..65].copy_from_slice(&y);
                if is_valid_p256_point(&cand) {
                    return Some(cand);
                }
            }
        }
    }
    None
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
struct U256([u64; 4]);

const P256_ZERO: U256 = U256([0, 0, 0, 0]);
const P256_ONE: U256 = U256([1, 0, 0, 0]);

const P256_P: U256 = U256([
    0xFFFFFFFFFFFFFFFF,
    0x00000000FFFFFFFF,
    0x0000000000000000,
    0xFFFFFFFF00000001,
]);

const P256_N: U256 = U256([
    0xF3B9CAC2FC632551,
    0xBCE6FAADA7179E84,
    0xFFFFFFFFFFFFFFFF,
    0xFFFFFFFF00000000,
]);

const P256_B: U256 = U256([
    0x3BCE3C3E27D2604B,
    0x651D06B0CC53B0F6,
    0xB3EBBD55769886BC,
    0x5AC635D8AA3A93E7,
]);

const P256_GX: U256 = U256([
    0xF4A13945D898C296,
    0x77037D812DEB33A0,
    0xF8BCE6E563A440F2,
    0x6B17D1F2E12C4247,
]);

const P256_GY: U256 = U256([
    0xCBB6406837BF51F5,
    0x2BCE33576B315ECE,
    0x8EE7EB4A7C0F9E16,
    0x4FE342E2FE1A7F9B,
]);

impl U256 {
    fn from_be_bytes(b: &[u8; 32]) -> Self {
        let l3 = u64::from_be_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]]);
        let l2 = u64::from_be_bytes([b[8], b[9], b[10], b[11], b[12], b[13], b[14], b[15]]);
        let l1 = u64::from_be_bytes([b[16], b[17], b[18], b[19], b[20], b[21], b[22], b[23]]);
        let l0 = u64::from_be_bytes([b[24], b[25], b[26], b[27], b[28], b[29], b[30], b[31]]);
        Self([l0, l1, l2, l3])
    }

    fn is_zero(&self) -> bool {
        (self.0[0] | self.0[1] | self.0[2] | self.0[3]) == 0
    }

    fn bit(&self, idx: usize) -> bool {
        let word = idx / 64;
        let bit = idx % 64;
        if word >= 4 {
            false
        } else {
            ((self.0[word] >> bit) & 1) == 1
        }
    }

    fn ge(&self, other: &Self) -> bool {
        for i in (0..4).rev() {
            if self.0[i] > other.0[i] {
                return true;
            }
            if self.0[i] < other.0[i] {
                return false;
            }
        }
        true
    }

    fn add_raw(&self, other: &Self) -> (Self, u64) {
        let mut out = [0u64; 4];
        let mut carry = 0u128;
        for i in 0..4 {
            let sum = (self.0[i] as u128) + (other.0[i] as u128) + carry;
            out[i] = sum as u64;
            carry = sum >> 64;
        }
        (Self(out), carry as u64)
    }

    fn sub_raw(&self, other: &Self) -> (Self, u64) {
        let mut out = [0u64; 4];
        let mut borrow = 0u128;
        for i in 0..4 {
            let a = self.0[i] as u128;
            let b = (other.0[i] as u128) + borrow;
            if a >= b {
                out[i] = (a - b) as u64;
                borrow = 0;
            } else {
                out[i] = ((1u128 << 64) + a - b) as u64;
                borrow = 1;
            }
        }
        (Self(out), borrow as u64)
    }

    fn rem_mod(&self, m: &Self) -> Self {
        let mut cur = *self;
        while cur.ge(m) {
            cur = cur.sub_raw(m).0;
        }
        cur
    }

    fn add_mod(&self, other: &Self, m: &Self) -> Self {
        let (sum, carry) = self.add_raw(other);
        if carry > 0 || sum.ge(m) {
            sum.sub_raw(m).0
        } else {
            sum
        }
    }

    fn sub_mod(&self, other: &Self, m: &Self) -> Self {
        if self.ge(other) {
            self.sub_raw(other).0
        } else {
            let diff = other.sub_raw(self).0;
            m.sub_raw(&diff).0
        }
    }

    fn mul_mod(&self, other: &Self, m: &Self) -> Self {
        let mut acc = P256_ZERO;
        let a = self.rem_mod(m);
        for i in (0..256).rev() {
            acc = acc.add_mod(&acc, m);
            if other.bit(i) {
                acc = acc.add_mod(&a, m);
            }
        }
        acc
    }

    fn pow_mod(&self, exp: &Self, m: &Self) -> Self {
        let mut res = P256_ONE;
        let base = self.rem_mod(m);
        for i in (0..256).rev() {
            res = res.mul_mod(&res, m);
            if exp.bit(i) {
                res = res.mul_mod(&base, m);
            }
        }
        res
    }

    fn inv_mod(&self, m: &Self) -> Option<Self> {
        if self.is_zero() {
            return None;
        }
        let two = U256([2, 0, 0, 0]);
        let exp = m.sub_raw(&two).0;
        Some(self.pow_mod(&exp, m))
    }
}

#[derive(Clone, Copy, Debug)]
struct P256Point {
    x: U256,
    y: U256,
    z: U256,
}

impl P256Point {
    fn infinity() -> Self {
        Self {
            x: P256_ZERO,
            y: P256_ONE,
            z: P256_ZERO,
        }
    }

    fn is_infinity(&self) -> bool {
        self.z.is_zero()
    }

    fn from_affine(x: U256, y: U256) -> Self {
        Self { x, y, z: P256_ONE }
    }

    fn generator() -> Self {
        Self::from_affine(P256_GX, P256_GY)
    }

    fn double(&self) -> Self {
        if self.is_infinity() || self.y.is_zero() {
            return Self::infinity();
        }
        let p = &P256_P;
        let delta = self.z.mul_mod(&self.z, p);
        let gamma = self.y.mul_mod(&self.y, p);
        let beta = self.x.mul_mod(&gamma, p);

        let x_minus_delta = self.x.sub_mod(&delta, p);
        let x_plus_delta = self.x.add_mod(&delta, p);
        let prod = x_minus_delta.mul_mod(&x_plus_delta, p);
        let alpha = prod.add_mod(&prod, p).add_mod(&prod, p);

        let two_beta = beta.add_mod(&beta, p);
        let four_beta = two_beta.add_mod(&two_beta, p);
        let eight_beta = four_beta.add_mod(&four_beta, p);

        let x3 = alpha.mul_mod(&alpha, p).sub_mod(&eight_beta, p);

        let y_plus_z = self.y.add_mod(&self.z, p);
        let z3 = y_plus_z
            .mul_mod(&y_plus_z, p)
            .sub_mod(&gamma, p)
            .sub_mod(&delta, p);

        let gamma_sq = gamma.mul_mod(&gamma, p);
        let two_gamma_sq = gamma_sq.add_mod(&gamma_sq, p);
        let four_gamma_sq = two_gamma_sq.add_mod(&two_gamma_sq, p);
        let eight_gamma_sq = four_gamma_sq.add_mod(&four_gamma_sq, p);

        let y3 = alpha
            .mul_mod(&four_beta.sub_mod(&x3, p), p)
            .sub_mod(&eight_gamma_sq, p);

        Self { x: x3, y: y3, z: z3 }
    }

    fn add(&self, other: &Self) -> Self {
        if self.is_infinity() {
            return *other;
        }
        if other.is_infinity() {
            return *self;
        }
        let p = &P256_P;
        let z1z1 = self.z.mul_mod(&self.z, p);
        let z2z2 = other.z.mul_mod(&other.z, p);
        let u1 = self.x.mul_mod(&z2z2, p);
        let u2 = other.x.mul_mod(&z1z1, p);
        let z2_cubed = other.z.mul_mod(&z2z2, p);
        let z1_cubed = self.z.mul_mod(&z1z1, p);
        let s1 = self.y.mul_mod(&z2_cubed, p);
        let s2 = other.y.mul_mod(&z1_cubed, p);

        if u1 == u2 {
            if s1 != s2 {
                return Self::infinity();
            }
            return self.double();
        }

        let h = u2.sub_mod(&u1, p);
        let r = s2.sub_mod(&s1, p);
        let hh = h.mul_mod(&h, p);
        let hhh = h.mul_mod(&hh, p);
        let u1hh = u1.mul_mod(&hh, p);

        let two_u1hh = u1hh.add_mod(&u1hh, p);
        let x3 = r.mul_mod(&r, p).sub_mod(&hhh, p).sub_mod(&two_u1hh, p);
        let y3 = r
            .mul_mod(&u1hh.sub_mod(&x3, p), p)
            .sub_mod(&s1.mul_mod(&hhh, p), p);
        let z3 = h.mul_mod(&self.z, p).mul_mod(&other.z, p);

        Self { x: x3, y: y3, z: z3 }
    }

    fn scalar_mul(&self, k: &U256) -> Self {
        let mut acc = Self::infinity();
        for i in (0..256).rev() {
            acc = acc.double();
            if k.bit(i) {
                acc = acc.add(self);
            }
        }
        acc
    }

    fn to_affine_x(&self) -> Option<U256> {
        if self.is_infinity() {
            return None;
        }
        let p = &P256_P;
        let z_inv = self.z.inv_mod(p)?;
        let z_inv2 = z_inv.mul_mod(&z_inv, p);
        Some(self.x.mul_mod(&z_inv2, p))
    }
}

pub fn is_valid_p256_point(uncompressed: &[u8]) -> bool {
    if uncompressed.len() != 65 || uncompressed[0] != 0x04 {
        return false;
    }
    let mut xb = [0u8; 32];
    let mut yb = [0u8; 32];
    xb.copy_from_slice(&uncompressed[1..33]);
    yb.copy_from_slice(&uncompressed[33..65]);
    let x = U256::from_be_bytes(&xb);
    let y = U256::from_be_bytes(&yb);
    if x.ge(&P256_P) || y.ge(&P256_P) || (x.is_zero() && y.is_zero()) {
        return false;
    }
    let p = &P256_P;
    let lhs = y.mul_mod(&y, p);
    let x2 = x.mul_mod(&x, p);
    let x3 = x2.mul_mod(&x, p);
    let three_x = x.add_mod(&x, p).add_mod(&x, p);
    let rhs = x3.sub_mod(&three_x, p).add_mod(&P256_B, p);
    lhs == rhs
}

fn parse_ecdsa_sig_rs(sig: &[u8]) -> Option<(U256, U256)> {
    if sig.len() == 64 {
        let mut rb = [0u8; 32];
        let mut sb = [0u8; 32];
        rb.copy_from_slice(&sig[0..32]);
        sb.copy_from_slice(&sig[32..64]);
        return Some((U256::from_be_bytes(&rb), U256::from_be_bytes(&sb)));
    }
    if sig.len() < 8 || sig[0] != 0x30 {
        return None;
    }
    let mut idx = 1;
    let _seq_len = if (sig[idx] & 0x80) == 0 {
        let l = sig[idx] as usize;
        idx += 1;
        l
    } else {
        let nbytes = (sig[idx] & 0x7f) as usize;
        if nbytes == 0 || nbytes > 2 || idx + nbytes >= sig.len() {
            return None;
        }
        idx += 1 + nbytes;
        0
    };

    let read_int = |pos: &mut usize| -> Option<U256> {
        if *pos + 2 > sig.len() || sig[*pos] != 0x02 {
            return None;
        }
        let len = sig[*pos + 1] as usize;
        *pos += 2;
        if *pos + len > sig.len() || len == 0 {
            return None;
        }
        let mut slice = &sig[*pos..*pos + len];
        *pos += len;
        while slice.len() > 1 && slice[0] == 0x00 {
            slice = &slice[1..];
        }
        if slice.len() > 32 {
            return None;
        }
        let mut buf = [0u8; 32];
        buf[32 - slice.len()..].copy_from_slice(slice);
        Some(U256::from_be_bytes(&buf))
    };

    let r = read_int(&mut idx)?;
    let s = read_int(&mut idx)?;
    Some((r, s))
}

pub fn verify_p256_ecdsa(pub_key_uncompressed: &[u8], msg_hash: &[u8; 32], sig: &[u8]) -> bool {
    if !is_valid_p256_point(pub_key_uncompressed) {
        return false;
    }
    let Some((r, s)) = parse_ecdsa_sig_rs(sig) else {
        return false;
    };
    let n = &P256_N;
    if r.is_zero() || r.ge(n) || s.is_zero() || s.ge(n) {
        return false;
    }
    let mut xb = [0u8; 32];
    let mut yb = [0u8; 32];
    xb.copy_from_slice(&pub_key_uncompressed[1..33]);
    yb.copy_from_slice(&pub_key_uncompressed[33..65]);
    let q = P256Point::from_affine(U256::from_be_bytes(&xb), U256::from_be_bytes(&yb));

    let z = U256::from_be_bytes(msg_hash).rem_mod(n);
    let Some(w) = s.inv_mod(n) else {
        return false;
    };
    let u1 = z.mul_mod(&w, n);
    let u2 = r.mul_mod(&w, n);

    let g = P256Point::generator();
    let p1 = g.scalar_mul(&u1);
    let p2 = q.scalar_mul(&u2);
    let pt = p1.add(&p2);
    let Some(affine_x) = pt.to_affine_x() else {
        return false;
    };
    let v = affine_x.rem_mod(n);
    v == r
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_p256_generator_and_ecdsa_verification() {
        let mut g_bytes = [0u8; 65];
        g_bytes[0] = 0x04;
        g_bytes[1..33].copy_from_slice(
            &hex::decode("6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296")
                .unwrap(),
        );
        g_bytes[33..65].copy_from_slice(
            &hex::decode("4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5")
                .unwrap(),
        );
        assert!(is_valid_p256_point(&g_bytes));

        let mut q_bytes = [0u8; 65];
        q_bytes[0] = 0x04;
        q_bytes[1..33].copy_from_slice(
            &hex::decode("60FED4BA255A9D31C961EB74C6356D68C049B8923B61FA6CE669622E60F29FB6")
                .unwrap(),
        );
        q_bytes[33..65].copy_from_slice(
            &hex::decode("7903FE1008B8BC99A41AE9E95628BC64F2F1B20C2D7E9F5177A3C294D4462299")
                .unwrap(),
        );
        assert!(is_valid_p256_point(&q_bytes));

        use sha2::{Digest, Sha256};
        let digest = Sha256::digest(b"sample");
        let mut msg_hash = [0u8; 32];
        msg_hash.copy_from_slice(&digest);

        let raw_sig = hex::decode(
            "EFD48B2AACB6A8FD1140DD9CD45E81D69D2C877B56AAF991C34D0EA84EAF3716\
             F7CB1C942D657C41D436C7A1B6E29F65F3E900DBB9AFF4064DC4AB2F843ACDA8",
        )
        .unwrap();
        assert!(verify_p256_ecdsa(&q_bytes, &msg_hash, &raw_sig));

        let mut bad_sig = raw_sig.clone();
        bad_sig[10] ^= 0x01;
        assert!(!verify_p256_ecdsa(&q_bytes, &msg_hash, &bad_sig));

        // Verify COSE_Key extraction from WebAuthn authenticatorData where Y is at the very end
        let mut fake_auth_data = vec![0u8; 55];
        fake_auth_data[32] = 0x45; // UP + UV + AT
        fake_auth_data[53] = 0x00;
        fake_auth_data[54] = 0x10; // 16-byte credentialId
        fake_auth_data.extend_from_slice(&[0xAA; 16]);
        // COSE_Key header: a5 01 02 03 26 20 01 21 58 20 <32-byte X> 22 58 20 <32-byte Y>
        fake_auth_data.extend_from_slice(&[0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]);
        fake_auth_data.extend_from_slice(&q_bytes[1..33]);
        fake_auth_data.extend_from_slice(&[0x22, 0x58, 0x20]);
        fake_auth_data.extend_from_slice(&q_bytes[33..65]);
        assert_eq!(extract_p256_pubkey(&fake_auth_data), Some(q_bytes));
    }
}

