import { joiResolver } from '@hookform/resolvers/joi'
import classNames from 'classnames'
import Joi from 'joi'
import { range } from 'lodash-es'
import { ClipboardEvent, useEffect, useState } from 'react'
import { useFieldArray, useForm, useWatch } from 'react-hook-form'
import { useTranslation } from 'react-i18next'

import words from '~config/wordlist_en.json'

import ErrorMessage from './ErrorMessage'

interface IForm {
    phrases: { value: string }[]
}

interface IProps {
    defaultValues?: string[]
    disabled?: boolean | boolean[]
    readOnly?: boolean | boolean[]
    schema?: Joi.ObjectSchema
    onChange?: (isValid: boolean, ˇs: string[]) => void
    showPasteHint?: boolean
}

function Mnemonic({
    defaultValues,
    disabled = false,
    readOnly = false,
    schema = Joi.object({ phrases: Joi.array().required() }),
    onChange,
    showPasteHint = false,
}: IProps) {
    const { t } = useTranslation()
    const [pasteHint, setPasteHint] = useState<boolean>(true)
    const [pasteHintIndex, setPasteHintIndex] = useState<number>(-1)
    const {
        control,
        register,
        reset,
        trigger,
        setFocus,
        setValue,
        formState: { errors, dirtyFields, isValid },
    } = useForm<IForm>({
        mode: 'onChange',
        reValidateMode: 'onChange',
        resolver: joiResolver(schema),
        shouldUnregister: true,
        defaultValues: defaultValues
            ? {
                  phrases: defaultValues.map((value) => ({ value })),
              }
            : {},
    })
    const { fields } = useFieldArray<IForm>({
        control,
        name: 'phrases',
    })

    const length = fields.length
    const values = useWatch({ control, name: 'phrases' })
    const [error, field] = Array.isArray(errors.phrases)
        ? [errors.phrases.find((item) => item), 'value']
        : [errors, 'phrases']

    const nextField = (currentIndex: number = -1) => {
        const nextIndex = values.findIndex(
            (field, index) => !field.value && index > currentIndex
        )
        if (nextIndex !== -1) {
            setFocus(`phrases.${nextIndex}.value` as const, {
                shouldSelect: true,
            })
        } else {
            const emptyFieldsLength =
                length -
                (dirtyFields.phrases?.filter((item) => item).length ?? 0)
            if (!isValid && emptyFieldsLength > 0) nextField()
            else {
                // go to first field with wrong value
                if (Array.isArray(errors.phrases)) {
                    const nextIndex = errors.phrases.findIndex((item) => item)
                    if (nextIndex !== -1) {
                        setFocus(`phrases.${nextIndex}.value` as const, {
                            shouldSelect: true,
                        })
                    }
                }
            }
        }
    }

    const onPaste = (from: number, e: ClipboardEvent<HTMLInputElement>) => {
        e.preventDefault()
        let lastIndex = 0
        const phrases = e.clipboardData.getData('text').split(' ')
        if (phrases.length === length) {
            setValue(
                'phrases',
                phrases.map((phrase) => ({
                    value: phrase,
                }))
            )
            return
        }
        range(from, Math.min(from + phrases.length, length)).forEach(
            (fieldIndex, index) => {
                if (phrases[index]) {
                    setValue(
                        `phrases.${fieldIndex}.value` as const,
                        phrases[index]
                    )
                    lastIndex = fieldIndex
                }
            }
        )
        setFocus(`phrases.${lastIndex}.value` as const)
        trigger()
    }

    const onFocus = (index: number) => {
        if (values.every((value) => !value.value)) {
            setPasteHintIndex(index)
            setPasteHint(true)
        }
    }

    useEffect(() => {
        if (!defaultValues?.every((value) => !value)) {
            reset({ phrases: defaultValues?.map((value) => ({ value })) })
            requestAnimationFrame(() => {
                const _disabled = Array.isArray(disabled)
                    ? disabled.every((item) => item)
                    : disabled
                const _readOnly = Array.isArray(readOnly)
                    ? readOnly.every((item) => item)
                    : readOnly
                if (!_disabled && !_readOnly) nextField()
            })
        }
    }, [defaultValues, disabled, readOnly])

    useEffect(() => {
        onChange?.(
            isValid,
            values.map((e) => e.value)
        )
        if (pasteHint) {
            if (values.some((value) => value)) {
                setPasteHint(false)
            }
        }
    }, [isValid, values])

    return (
        <>
            <form className="grid grid-cols-3 gap-2 [&>:not(div)]:absolute">
                {fields.map((field, index) => (
                    <div key={field.id} className="relative">
                        <input
                            key={field.id}
                            {...register(`phrases.${index}.value` as const, {
                                onChange: () => {
                                    trigger()
                                },
                            })}
                            defaultValue={field.value}
                            className={`input input-mnemonics ${classNames({
                                'input-error':
                                    errors.phrases?.[index] ||
                                    (values[index].value &&
                                        !words.some(
                                            (word) =>
                                                word === values[index].value
                                        )),
                            })}`}
                            disabled={disabled[index] ?? disabled}
                            readOnly={readOnly[index] ?? readOnly}
                            placeholder={`Phrase ${index + 1}`}
                            onKeyDown={(e) => {
                                // press enter to next field
                                if (e.key === 'Enter') {
                                    nextField(index)
                                }
                            }}
                            onPaste={(e) => onPaste(index, e)}
                            onFocus={() => onFocus(index)}
                            onBlur={() => setPasteHint(false)}
                        />
                        {showPasteHint && (
                            <div
                                className={classNames(
                                    "absolute top-full translate-y-3  bg-primary-100 text-secondary px-3 py-2 w-44 rounded-sm z-50 left-1/2 -translate-x-1/2 text-xs text-center after:content-[''] after:absolute after:w-3 after:h-3 after:bg-primary-100 after:left-1/2 after:-translate-x-1/2 after:-top-1 after:rotate-45",
                                    (!pasteHint || index !== pasteHintIndex) &&
                                        'hidden'
                                )}
                            >
                                <span>{t('tooltip-paste_hint')}</span>
                            </div>
                        )}
                    </div>
                ))}
            </form>
            {!isValid && (
                <ErrorMessage
                    field={{ key: field }}
                    errors={error}
                    t={t}
                    className="w-full mt-4 text-center"
                />
            )}
        </>
    )
}

export default Mnemonic