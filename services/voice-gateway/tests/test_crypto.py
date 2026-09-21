from voice_gateway.crypto import decrypt_provider_config, encrypt_provider_config, is_encrypted_config


def test_encrypt_decrypt_roundtrip():
    plaintext = {"api_key": "fake_api_key", "model": "saaras:v3-realtime"}
    encrypted = encrypt_provider_config(plaintext)
    assert is_encrypted_config(encrypted)
    assert decrypt_provider_config(encrypted) == plaintext


def test_is_encrypted_config_rejects_plain_dict():
    assert is_encrypted_config({"foo": "bar"}) is False
