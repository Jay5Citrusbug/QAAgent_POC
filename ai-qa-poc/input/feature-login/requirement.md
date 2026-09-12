# Sign-in

> **Worked example for the two-phase flow (VISION §5a).** This is a deliberately
> ordinary, under-specified requirement — the kind that actually arrives. Read it
> alongside `clarifications.yaml` in this folder: the gaps it leaves are the
> point of the example, not an oversight in writing it.
>
> No front-end exists for this feature. That is the condition the intent
> artifact was built for.

## R-1 — Sign in with email and password

A registered user can sign in with their email address and password. On
success they land on their dashboard.

## R-2 — Wrong credentials

If the email or the password is wrong, the user is not signed in and is shown
an error.

## R-3 — Repeated failures

Repeated failed attempts must not allow brute-forcing an account.

## R-4 — Stay signed in

The sign-in form offers a "stay signed in" option.

## R-5 — Forgotten password

A user who has forgotten their password can request a reset link from the
sign-in screen.
