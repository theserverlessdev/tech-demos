export type LitmusSuite = {
  name: string;
  passed: number;
  failed: number;
  /** When this suite was invoked, if the run recorded it. */
  at?: string;
  /** Unedited litmus output for this suite. Required when the run is real. */
  raw: string;
};

/**
 * Filled from a real `litmus` invocation against `wrangler dev`.
 * Raw lines keep the carriage returns litmus uses to redraw each test.
 * Each suite has its own start time. The header `at` is the first suite.
 */
export const LITMUS_RESULTS: {
  ran: boolean;
  at: string | null;
  command: string | null;
  note: string;
  suites: LitmusSuite[];
} = {
  "ran": true,
  "at": "2026-10-23T17:54:22Z",
  "command": "TESTS=<suite> litmus -k http://127.0.0.1:8808/dav/drv_1817f4b0bb669f02c882323188a13198/ drv_1817f4b0bb669f02c882323188a13198 <password>",
  "note": "litmus 0.13 (Ubuntu 0.13-5build2) against wrangler dev on 2026-10-23, after the trailer and lock-cap changes. Suites were run separately so the 120 writes/minute limit did not turn later tests into 429s. Each suite records its own start time. basic 16/16 with one warning (DELETE of a collection whose Request-URI included a fragment), copymove 13/13, props 30/30, locks 41/41, and http 4/4, including expect100.",
  "suites": [
    {
      "name": "basic",
      "passed": 16,
      "failed": 0,
      "at": "2026-10-23T17:54:22Z",
      "raw": "-> running `basic':\n\r 0. init.................. \r 0. init.................. pass\n\r 1. begin................. \r 1. begin................. pass\n\r 2. options............... \r 2. options............... pass\n\r 3. put_get............... \r 3. put_get............... pass\n\r 4. put_get_utf8_segment.. \r 4. put_get_utf8_segment.. pass\n\r 5. put_no_parent......... \r 5. put_no_parent......... pass\n\r 6. mkcol_over_plain...... \r 6. mkcol_over_plain...... pass\n\r 7. delete................ \r 7. delete................ pass\n\r 8. delete_null........... \r 8. delete_null........... pass\n\r 9. delete_fragment....... WARNING: DELETE removed collection resource with Request-URI including fragment; unsafe\n    ...................... pass (with 1 warning)\n    ...................... \r10. mkcol................. pass\n\r11. mkcol_again........... \r11. mkcol_again........... pass\n\r12. delete_coll........... \r12. delete_coll........... pass\n\r13. mkcol_no_parent....... \r13. mkcol_no_parent....... pass\n\r14. mkcol_with_body....... \r14. mkcol_with_body....... pass\n\r15. finish................ \r15. finish................ pass\n<- summary for `basic': of 16 tests run: 16 passed, 0 failed. 100.0%\n-> 1 warning was issued.\n"
    },
    {
      "name": "copymove",
      "passed": 13,
      "failed": 0,
      "at": "2026-10-23T17:55:32Z",
      "raw": "-> running `copymove':\n\r 0. init.................. \r 0. init.................. pass\n\r 1. begin................. \r 1. begin................. pass\n\r 2. copy_init............. \r 2. copy_init............. pass\n\r 3. copy_simple........... \r 3. copy_simple........... pass\n\r 4. copy_overwrite........ \r 4. copy_overwrite........ pass\n\r 5. copy_nodestcoll....... \r 5. copy_nodestcoll....... pass\n\r 6. copy_cleanup.......... \r 6. copy_cleanup.......... pass\n\r 7. copy_coll............. \r 7. copy_coll............. pass\n\r 8. copy_shallow.......... \r 8. copy_shallow.......... pass\n\r 9. move.................. \r 9. move.................. pass\n\r10. move_coll............. \r10. move_coll............. pass\n\r11. move_cleanup.......... \r11. move_cleanup.......... pass\n\r12. finish................ \r12. finish................ pass\n<- summary for `copymove': of 13 tests run: 13 passed, 0 failed. 100.0%\n"
    },
    {
      "name": "props",
      "passed": 30,
      "failed": 0,
      "at": "2026-10-23T17:56:45Z",
      "raw": "-> running `props':\n\r 0. init.................. \r 0. init.................. pass\n\r 1. begin................. \r 1. begin................. pass\n\r 2. propfind_invalid...... \r 2. propfind_invalid...... pass\n\r 3. propfind_invalid2..... \r 3. propfind_invalid2..... pass\n\r 4. propfind_d0........... \r 4. propfind_d0........... pass\n\r 5. propinit.............. \r 5. propinit.............. pass\n\r 6. propset............... \r 6. propset............... pass\n\r 7. propget............... \r 7. propget............... pass\n\r 8. propextended.......... \r 8. propextended.......... pass\n\r 9. propmove.............. \r 9. propmove.............. pass\n\r10. propget............... \r10. propget............... pass\n\r11. propdeletes........... \r11. propdeletes........... pass\n\r12. propget............... \r12. propget............... pass\n\r13. propreplace........... \r13. propreplace........... pass\n\r14. propget............... \r14. propget............... pass\n\r15. propnullns............ \r15. propnullns............ pass\n\r16. propget............... \r16. propget............... pass\n\r17. prophighunicode....... \r17. prophighunicode....... pass\n\r18. propget............... \r18. propget............... pass\n\r19. propremoveset......... \r19. propremoveset......... pass\n\r20. propget............... \r20. propget............... pass\n\r21. propsetremove......... \r21. propsetremove......... pass\n\r22. propget............... \r22. propget............... pass\n\r23. propvalnspace......... \r23. propvalnspace......... pass\n\r24. propwformed........... \r24. propwformed........... pass\n\r25. propinit.............. \r25. propinit.............. pass\n\r26. propmanyns............ \r26. propmanyns............ pass\n\r27. propget............... \r27. propget............... pass\n\r28. propcleanup........... \r28. propcleanup........... pass\n\r29. finish................ \r29. finish................ pass\n<- summary for `props': of 30 tests run: 30 passed, 0 failed. 100.0%\n"
    },
    {
      "name": "locks",
      "passed": 41,
      "failed": 0,
      "at": "2026-10-23T17:57:56Z",
      "raw": "-> running `locks':\n\r 0. init.................. \r 0. init.................. pass\n\r 1. begin................. \r 1. begin................. pass\n\r 2. options............... \r 2. options............... pass\n\r 3. precond............... \r 3. precond............... pass\n\r 4. init_locks............ \r 4. init_locks............ pass\n\r 5. put................... \r 5. put................... pass\n\r 6. lock_excl............. \r 6. lock_excl............. pass\n\r 7. discover.............. \r 7. discover.............. pass\n\r 8. refresh............... \r 8. refresh............... pass\n\r 9. notowner_modify....... \r 9. notowner_modify....... pass\n\r10. notowner_lock......... \r10. notowner_lock......... pass\n\r11. owner_modify.......... \r11. owner_modify.......... pass\n\r12. notowner_modify....... \r12. notowner_modify....... pass\n\r13. notowner_lock......... \r13. notowner_lock......... pass\n\r14. copy.................. \r14. copy.................. pass\n\r15. cond_put.............. \r15. cond_put.............. pass\n\r16. fail_cond_put......... \r16. fail_cond_put......... pass\n\r17. cond_put_with_not..... \r17. cond_put_with_not..... pass\n\r18. cond_put_corrupt_token \r18. cond_put_corrupt_token pass\n\r19. complex_cond_put...... \r19. complex_cond_put...... pass\n\r20. fail_complex_cond_put. \r20. fail_complex_cond_put. pass\n\r21. unlock................ \r21. unlock................ pass\n\r22. fail_cond_put_unlocked \r22. fail_cond_put_unlocked pass\n\r23. lock_shared........... \r23. lock_shared........... pass\n\r24. notowner_modify....... \r24. notowner_modify....... pass\n\r25. notowner_lock......... \r25. notowner_lock......... pass\n\r26. owner_modify.......... \r26. owner_modify.......... pass\n\r27. double_sharedlock..... \r27. double_sharedlock..... pass\n\r28. notowner_modify....... \r28. notowner_modify....... pass\n\r29. notowner_lock......... \r29. notowner_lock......... pass\n\r30. unlock................ \r30. unlock................ pass\n\r31. prep_collection....... \r31. prep_collection....... pass\n\r32. lock_collection....... \r32. lock_collection....... pass\n\r33. owner_modify.......... \r33. owner_modify.......... pass\n\r34. notowner_modify....... \r34. notowner_modify....... pass\n\r35. refresh............... \r35. refresh............... pass\n\r36. indirect_refresh...... \r36. indirect_refresh...... pass\n\r37. unlock................ \r37. unlock................ pass\n\r38. unmapped_lock......... \r38. unmapped_lock......... pass\n\r39. unlock................ \r39. unlock................ pass\n\r40. finish................ \r40. finish................ pass\n<- summary for `locks': of 41 tests run: 41 passed, 0 failed. 100.0%\n"
    },
    {
      "name": "http",
      "passed": 4,
      "failed": 0,
      "at": "2026-10-23T17:59:07Z",
      "raw": "-> running `http':\n\r 0. init.................. \r 0. init.................. pass\n\r 1. begin................. \r 1. begin................. pass\n\r 2. expect100............. \r 2. expect100............. pass\n\r 3. finish................ \r 3. finish................ pass\n<- summary for `http': of 4 tests run: 4 passed, 0 failed. 100.0%\n"
    },
  ]
};
