# Signing your commits

The `main` branch of this repo enforces [**signature verification**](https://docs.github.com/en/authentication/managing-commit-signature-verification/about-commit-signature-verification) via a repository ruleset. Every commit that lands on `main` — including ones you push to a feature branch that later merges — must be signed with a verified key, or GitHub will reject the merge.

This guide walks you through setting up signing **once per machine**. You can pick SSH signing (recommended — reuses your existing SSH auth key) or GPG signing.

## Option A: SSH signing (recommended)

This reuses the SSH key you already use to authenticate `git push`. Requires Git ≥ 2.34 (`git --version`).

### 1. Find the public key you want to sign with

Usually one of:

```bash
ls -la ~/.ssh/id_ed25519.pub ~/.ssh/id_rsa.pub
```

If you don't have one yet, create a new ed25519 key:

```bash
ssh-keygen -t ed25519 -C "your_email@example.com"
```

### 2. Configure git to sign with that key

```bash
git config --global gpg.format ssh
git config --global user.signingkey ~/.ssh/id_ed25519.pub
git config --global commit.gpgsign true
git config --global tag.gpgsign true
```

### 3. Register the key on GitHub **as a signing key**

> Important: a key used for SSH auth is not automatically a signing key on GitHub. You need to add it twice — once as "Authentication Key", once as "Signing Key" — or add a dedicated signing key.

1. Go to https://github.com/settings/ssh/new
2. Paste the contents of `~/.ssh/id_ed25519.pub`.
3. For **Key type**, choose **Signing Key**.
4. Save.

### 4. Verify

```bash
git commit --allow-empty -m "test: signing"
git log --show-signature -1
```

You should see `Good "git" signature for <your email>`. Push the commit and check on github.com — the commit line should show a green **Verified** badge.

## Option B: GPG signing

Traditional setup. Use this if you already have a GPG key, or if your organization requires GPG specifically.

```bash
# 1. Generate a key (skip if you already have one).
gpg --full-generate-key
# Choose RSA and RSA, 4096 bits, never expires (or your org's policy).

# 2. Find the key ID.
gpg --list-secret-keys --keyid-format=long
# Look for a line like: sec   rsa4096/ABCD1234EF567890 2024-...

# 3. Export the public key and copy it.
gpg --armor --export ABCD1234EF567890 | pbcopy   # macOS
# gpg --armor --export ABCD1234EF567890 | xclip -selection clipboard  # Linux

# 4. Register on GitHub:
#    https://github.com/settings/gpg/new → paste → Save.

# 5. Configure git.
git config --global user.signingkey ABCD1234EF567890
git config --global commit.gpgsign true
git config --global tag.gpgsign true
```

macOS users may need `pinentry-mac` so GPG can prompt for your passphrase in a GUI:

```bash
brew install pinentry-mac
echo "pinentry-program $(which pinentry-mac)" >> ~/.gnupg/gpg-agent.conf
gpgconf --kill gpg-agent
```

## FAQ

**What about the GitHub web UI?** Commits made in the GitHub web editor, and merges done with the "Merge"/"Squash"/"Rebase" buttons, are signed automatically by GitHub's server-side key. No setup needed.

**What about Dependabot?** Dependabot commits are signed automatically by GitHub. No setup needed.

**What about the `Bump Version` automation?** It commits via the GitHub REST API inside the Actions runner, which means `github-actions[bot]`'s server-side key signs the commit automatically. No setup needed.

**My commit already has my name but shows "Unverified" on github.com.** The signature is tied to an email, and that email must be on your GitHub account's list of verified emails (https://github.com/settings/emails). Use the same email in `git config user.email` as the one you registered on GitHub.

**I use multiple machines.** Repeat the setup on each one. SSH signing: the key on each machine must be registered on GitHub as a Signing Key.

**I use GitHub Desktop / VS Code's commit UI.** Both respect `git config commit.gpgsign true`, so once the CLI setup is done, UI commits sign too.

**I need to amend/rebase old unsigned commits.** `git rebase --exec 'git commit --amend --no-edit -n -S' <base>` re-signs each commit during the rebase. Force-push is not allowed on `main`, so only relevant for local branches before the first push.

## Troubleshooting

| Symptom                                                                  | Fix                                                                                                                                    |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `error: gpg failed to sign the data`                                     | Run `echo "test" \| gpg --clearsign` to see the real error; if it's about `no pinentry`, install `pinentry-mac` / `pinentry-curses`.   |
| `error: Load key ".../id_ed25519": invalid format` when signing with SSH | Your `gpg.format ssh` is set but `user.signingkey` points to the private key; it should point to the **public** key file (`.pub`).     |
| GitHub shows "Unverified" despite signing                                | The commit email is not a verified email on your GitHub account. Check `git config user.email` and https://github.com/settings/emails. |
| I need to sign historic commits before merging a long-lived branch       | `git rebase -x 'git commit --amend --no-edit -n -S' HEAD~N` (force-push to your branch is allowed; `main` protection doesn't apply).   |
